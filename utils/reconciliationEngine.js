/**
 * SafeRide AI — ReconciliationEngine Backend Service
 * 
 * Core Rule:
 * Every student has a pre-assigned expected drop-off stop. When a bus LEAVES a stop,
 * the system must verify that every student expected to exit at that stop has a recorded exit event.
 * If any are pending, create an incident BEFORE the bus moves on.
 */

const { dbQuery, dbGet, dbRun } = require('../db/database');

class ReconciliationEngine {
  constructor() {
    // In-memory fast cache for active trip plans: tripId -> { stopId: Set(studentIds) }
    this.activePlans = new Map();
    // Cache for configuration
    this.strictMode = false; // Config flag: if true, strictly halts trip departure on pending exits
  }

  setStrictMode(enabled) {
    this.strictMode = !!enabled;
  }

  /**
   * Helper: Generate minute-bucketed idempotency key for events
   */
  generateIdempotencyKey(tripId, studentId, type, stopId, timestamp = Date.now()) {
    const minuteBucket = Math.floor(new Date(timestamp).getTime() / 60000);
    return `ev_${tripId}_${studentId}_${type}_${stopId}_${minuteBucket}`;
  }

  /**
   * Helper: Log audit trail entry
   */
  async logAudit({ actorId = 'SYSTEM', action, entity, entityId, reason = null }) {
    await dbRun(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, reason) 
       VALUES (?, ?, ?, ?, ?)`,
      [actorId, action, entity, String(entityId), reason]
    );
  }

  /**
   * 1. Start Trip & Build Plan Map
   * On trip start: build a plan map {stop_id: [expected student_ids for this route]}.
   * Excludes students marked absent today.
   */
  async startTrip({ tripId, routeId = 1, busId = 1, driverId = 'DRV-01', attendantId = 'ATT-01', actorId = 'DRIVER-01' }) {
    const startTime = Date.now();

    // 1. Check or create trip in database
    let trip = await dbGet('SELECT * FROM trips WHERE id = ?', [tripId]);
    if (!trip) {
      await dbRun(
        `INSERT INTO trips (id, route_id, bus_id, driver_id, attendant_id, started_at, status) 
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'ACTIVE')`,
        [tripId, routeId, busId, driverId, attendantId]
      );
    } else {
      await dbRun(
        `UPDATE trips SET status = 'ACTIVE', started_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [tripId]
      );
    }

    // 2. Query route stops in sequence
    const stops = await dbQuery(
      `SELECT * FROM stops WHERE route_id = ? ORDER BY sequence ASC`,
      [routeId]
    );

    // 3. Query expected drops for this route
    const expectedDrops = await dbQuery(
      `SELECT ed.stop_id, ed.student_id, s.name as student_name, s.class, s.guardian_id
       FROM expected_drops ed
       JOIN students s ON ed.student_id = s.id
       WHERE ed.route_id = ? AND s.active = 1
       AND date('now') BETWEEN ed.active_from AND ed.active_to`,
      [routeId]
    );

    // 4. Edge Case: Query students marked absent today by school
    const absentRecords = await dbQuery(
      `SELECT student_id FROM school_attendance 
       WHERE date = date('now') AND status = 'ABSENT'`
    );
    const absentStudentIds = new Set(absentRecords.map(a => a.student_id));

    // 5. Build in-memory Plan Map: { stop_id: [ student records ] }
    const planMap = {};
    const excludedAbsents = [];

    stops.forEach(st => {
      planMap[st.id] = [];
    });

    expectedDrops.forEach(drop => {
      if (absentStudentIds.has(drop.student_id)) {
        excludedAbsents.push({
          student_id: drop.student_id,
          student_name: drop.student_name,
          stop_id: drop.stop_id,
          reason: 'Marked absent today by school office'
        });
        return; // Excluded from expected drop list!
      }

      if (!planMap[drop.stop_id]) {
        planMap[drop.stop_id] = [];
      }
      planMap[drop.stop_id].push({
        student_id: drop.student_id,
        student_name: drop.student_name,
        class: drop.class,
        guardian_id: drop.guardian_id
      });
    });

    this.activePlans.set(Number(tripId), planMap);

    await this.logAudit({
      actorId,
      action: 'TRIP_START',
      entity: 'TRIP',
      entityId: tripId,
      reason: `Trip started on route ${routeId} with ${expectedDrops.length - excludedAbsents.length} expected drops (${excludedAbsents.length} excluded as absent).`
    });

    const elapsedMs = Date.now() - startTime;

    return {
      success: true,
      trip_id: Number(tripId),
      route_id: routeId,
      status: 'ACTIVE',
      plan_map: planMap,
      excluded_absent_students: excludedAbsents,
      execution_ms: elapsedMs
    };
  }

  /**
   * 2. Geofence ENTER: Activates expected students for stop X
   */
  async handleGeofenceEnter({ tripId, stopId, actorId = 'GPS-DEVICE' }) {
    await dbRun('UPDATE trips SET current_stop_id = ? WHERE id = ?', [stopId, tripId]);

    const stop = await dbGet('SELECT * FROM stops WHERE id = ?', [stopId]);
    const plan = this.activePlans.get(Number(tripId)) || {};
    const expectedStudents = plan[stopId] || [];

    await this.logAudit({
      actorId,
      action: 'GEOFENCE_ENTER',
      entity: 'STOP',
      entityId: stopId,
      reason: `Bus entered geofence for stop ${stop ? stop.name : stopId}. ${expectedStudents.length} students expected to drop.`
    });

    return {
      success: true,
      trip_id: Number(tripId),
      current_stop: stop ? { id: stop.id, name: stop.name, sequence: stop.sequence } : { id: stopId },
      expected_drop_students: expectedStudents
    };
  }

  /**
   * 3. Boarding Event (BOARD / EXIT) with Idempotency & Mandatory Manual Reason
   */
  async recordEvent({ tripId, studentId, type, method, stopId, deviceId = 'DEV-BUS-01', timestamp = new Date().toISOString(), reason = null, actorId = 'ATTENDANT-01' }) {
    const cleanType = String(type).toUpperCase();
    const cleanMethod = String(method).toUpperCase();

    // Edge Case: Face / QR failure -> Attendant manual mark with mandatory reason
    if (cleanMethod === 'MANUAL' && (!reason || String(reason).trim().length < 3)) {
      throw new Error('Mandatory reason required for MANUAL event verification (e.g. "Face recognition failed in low lighting", "QR card damaged").');
    }

    // Edge Case: Idempotency protection against duplicate scans
    const idempotencyKey = this.generateIdempotencyKey(tripId, studentId, cleanType, stopId, timestamp);
    const existing = await dbGet('SELECT * FROM boarding_events WHERE idempotency_key = ?', [idempotencyKey]);
    if (existing) {
      return {
        success: true,
        duplicate: true,
        event_id: existing.id,
        message: `Duplicate scan detected for student ${studentId} in current time bucket. Preserved existing record.`,
        event: existing
      };
    }

    const res = await dbRun(
      `INSERT INTO boarding_events (trip_id, student_id, type, method, stop_id, timestamp, device_id, synced, idempotency_key, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [tripId, studentId, cleanType, cleanMethod, stopId, timestamp, deviceId, idempotencyKey, reason]
    );

    // If an EXIT event was recorded, auto-resolve any prior OPEN incident for this student at this stop
    if (cleanType === 'EXIT') {
      const openInc = await dbGet(
        `SELECT * FROM incidents WHERE trip_id = ? AND student_id = ? AND status = 'OPEN'`,
        [tripId, studentId]
      );
      if (openInc) {
        await dbRun(
          `UPDATE incidents SET status = 'RESOLVED', resolution_reason = 'Verified exited via subsequent scan', resolved_at = CURRENT_TIMESTAMP, resolved_by = ? WHERE id = ?`,
          [actorId, openInc.id]
        );
      }
    }

    return {
      success: true,
      duplicate: false,
      event_id: res.id,
      trip_id: Number(tripId),
      student_id: Number(studentId),
      type: cleanType,
      method: cleanMethod,
      stop_id: stopId,
      timestamp
    };
  }

  /**
   * 4. Geofence EXIT / DEPART STOP (The Core Custody Rule)
   * 
   * "When a bus LEAVES a stop, the system must verify that every student expected to exit 
   * at that stop has a recorded exit event. If any are pending, create an incident BEFORE the bus moves on."
   * Must execute in under 500ms.
   */
  async departStop({ tripId, stopId, strictMode = null, actorId = 'DRIVER-01' }) {
    const startTime = Date.now();
    const effectiveStrict = strictMode !== null ? !!strictMode : this.strictMode;

    const stop = await dbGet('SELECT * FROM stops WHERE id = ?', [stopId]);
    const stopName = stop ? stop.name : `Stop ${stopId}`;

    // 1. Get expected students for this stop
    let plan = this.activePlans.get(Number(tripId));
    let expectedForStop = [];

    if (plan && plan[stopId]) {
      expectedForStop = plan[stopId];
    } else {
      // Fallback query directly from expected_drops
      expectedForStop = await dbQuery(
        `SELECT ed.student_id, s.name as student_name, s.class, s.guardian_id
         FROM expected_drops ed
         JOIN students s ON ed.student_id = s.id
         WHERE ed.stop_id = ? AND s.active = 1`,
        [stopId]
      );
    }

    // 2. Query verified EXIT events for this trip and stop
    const exitedEvents = await dbQuery(
      `SELECT student_id, method, timestamp FROM boarding_events 
       WHERE trip_id = ? AND stop_id = ? AND type = 'EXIT'`,
      [tripId, stopId]
    );
    const exitedStudentIds = new Set(exitedEvents.map(e => e.student_id));

    // Also check students with resolved or overridden incidents for this trip & stop
    const resolvedIncs = await dbQuery(
      `SELECT student_id FROM incidents 
       WHERE trip_id = ? AND stop_id = ? AND status IN ('RESOLVED', 'OVERRIDE')`,
      [tripId, stopId]
    );
    const resolvedStudentIds = new Set(resolvedIncs.map(i => i.student_id));

    // 3. Find pending students: expected_drops[stop_id] - (exited_students + resolved_students)
    const pendingStudents = [];
    const clearedStudents = [];

    for (const exp of expectedForStop) {
      if (exitedStudentIds.has(exp.student_id) || resolvedStudentIds.has(exp.student_id)) {
        clearedStudents.push(exp);
      } else {
        pendingStudents.push(exp);
      }
    }

    const createdIncidents = [];

    // 4. If pending is not empty: Create incident per student BEFORE moving on
    if (pendingStudents.length > 0) {
      for (const p of pendingStudents) {
        // Check if an incident is already open for this student on this trip & stop
        const existingInc = await dbGet(
          `SELECT * FROM incidents 
           WHERE trip_id = ? AND student_id = ? AND stop_id = ? AND status IN ('OPEN', 'ASSIGNED')`,
          [tripId, p.student_id, stopId]
        );

        if (!existingInc) {
          const incRes = await dbRun(
            `INSERT INTO incidents (trip_id, student_id, stop_id, type, severity, status, assigned_to, resolution_reason)
             VALUES (?, ?, ?, 'MISSING_DROP_OFF', 'HIGH', 'OPEN', 'ATTENDANT-01', ?)`,
            [tripId, p.student_id, stopId, `Student ${p.student_name} expected to exit at ${stopName} has no recorded exit event.`]
          );

          createdIncidents.push({
            incident_id: incRes.id,
            student_id: p.student_id,
            student_name: p.student_name,
            stop_id: stopId,
            stop_name: stopName,
            severity: 'HIGH',
            status: 'OPEN'
          });

          await this.logAudit({
            actorId,
            action: 'INCIDENT_CREATE',
            entity: 'INCIDENT',
            entityId: incRes.id,
            reason: `MISSING_DROP_OFF: Student ${p.student_name} (ID: ${p.student_id}) missed exit at ${stopName}.`
          });
        } else {
          createdIncidents.push(existingInc);
        }
      }
    } else {
      // All cleared!
      await this.logAudit({
        actorId,
        action: 'STOP_RECONCILED',
        entity: 'TRIP',
        entityId: tripId,
        reason: `All ${clearedStudents.length} expected students successfully verified and exited at ${stopName}. Custody reconciled.`
      });
    }

    const elapsedMs = Date.now() - startTime;

    // Strict mode determination:
    // If strictMode is enabled and pending exists, departure is BLOCKED.
    // Otherwise, trip is allowed to proceed while emitting a blocking alert banner on device.
    const isBlocked = effectiveStrict && pendingStudents.length > 0;

    return {
      success: true,
      stop_id: Number(stopId),
      stop_name: stopName,
      trip_id: Number(tripId),
      reconciled: pendingStudents.length === 0,
      expected_count: expectedForStop.length,
      cleared_count: clearedStudents.length,
      pending_count: pendingStudents.length,
      pending_students: pendingStudents,
      incidents: createdIncidents,
      strict_mode: effectiveStrict,
      departure_allowed: !isBlocked,
      blocked: isBlocked,
      alert_level: pendingStudents.length > 0 ? 'CRITICAL_BLOCKING_ALERT' : 'NONE',
      alert_banner: pendingStudents.length > 0 ? {
        title: `STOP ${stopId} — MISSING DROP-OFF ALERT`,
        message: `${pendingStudents.length} student(s) pending exit: ${pendingStudents.map(s => s.student_name).join(', ')}. Attendant action required immediately.`,
        action_options: [
          'VERIFIED_IN_BUS',
          'VERIFIED_EXITED_MANUAL',
          'AUTHORISED_OVERRIDE'
        ]
      } : null,
      execution_ms: elapsedMs
    };
  }

  /**
   * 5. Attendant Resolution Actions
   * - "Verified in bus" → keep trip running, incident stays OPEN till next action.
   * - "Verified exited (record missed)" → mark exit event manual, close incident.
   * - "Authorised override" → requires reason, closes incident with OVERRIDE status, logged.
   */
  async resolveIncident({ incidentId, action, reason = '', actorId = 'ATTENDANT-01' }) {
    const inc = await dbGet('SELECT * FROM incidents WHERE id = ?', [incidentId]);
    if (!inc) {
      throw new Error(`Incident ${incidentId} not found.`);
    }

    const cleanAction = String(action).toUpperCase();
    let newStatus = inc.status;

    if (cleanAction === 'VERIFIED_IN_BUS') {
      // "Verified in bus" → keep trip running, incident stays OPEN till next action
      newStatus = 'OPEN';
      await dbRun(
        `UPDATE incidents SET resolution_reason = ?, resolved_by = ? WHERE id = ?`,
        [`Attendant confirmed student is still safely onboard bus. Reason: ${reason || 'Confirmed in bus.'}`, actorId, incidentId]
      );
      await this.logAudit({
        actorId,
        action: 'INCIDENT_VERIFIED_IN_BUS',
        entity: 'INCIDENT',
        entityId: incidentId,
        reason: reason || 'Student verified still on bus by attendant.'
      });
    } else if (cleanAction === 'VERIFIED_EXITED_MANUAL') {
      // "Verified exited (record missed)" → mark exit event manual, close incident
      newStatus = 'RESOLVED';
      await dbRun(
        `UPDATE incidents SET status = 'RESOLVED', resolution_reason = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = ? WHERE id = ?`,
        [`Verified exited manually: ${reason || 'Physical confirmation by attendant.'}`, actorId, incidentId]
      );

      // Record manual exit event in boarding_events
      await this.recordEvent({
        tripId: inc.trip_id,
        studentId: inc.student_id,
        type: 'EXIT',
        method: 'MANUAL',
        stopId: inc.stop_id,
        reason: reason || 'Manual verification by attendant — scanner missed.',
        actorId
      });

      await this.logAudit({
        actorId,
        action: 'INCIDENT_RESOLVE_MANUAL_EXIT',
        entity: 'INCIDENT',
        entityId: incidentId,
        reason: reason || 'Attendant recorded missed exit manually.'
      });
    } else if (cleanAction === 'AUTHORISED_OVERRIDE') {
      // "Authorised override" → requires reason, closes incident with OVERRIDE status, logged
      if (!reason || String(reason).trim().length < 5) {
        throw new Error('Mandatory authorized reason (min 5 chars) is required for safety override.');
      }
      newStatus = 'OVERRIDE';
      await dbRun(
        `UPDATE incidents SET status = 'OVERRIDE', resolution_reason = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = ? WHERE id = ?`,
        [reason, actorId, incidentId]
      );
      await this.logAudit({
        actorId,
        action: 'OVERRIDE',
        entity: 'INCIDENT',
        entityId: incidentId,
        reason: `Authorized override: ${reason}`
      });
    } else {
      throw new Error(`Invalid resolution action '${action}'. Allowed: VERIFIED_IN_BUS, VERIFIED_EXITED_MANUAL, AUTHORISED_OVERRIDE.`);
    }

    return {
      success: true,
      incident_id: Number(incidentId),
      action: cleanAction,
      status: newStatus,
      resolved_by: actorId,
      reason
    };
  }

  /**
   * 6. Live Trip Status & Pending List Per Stop
   */
  async getTripStatus(tripId) {
    const trip = await dbGet('SELECT * FROM trips WHERE id = ?', [tripId]);
    if (!trip) return null;

    const routeId = trip.route_id || 1;
    const stops = await dbQuery('SELECT * FROM stops WHERE route_id = ? ORDER BY sequence ASC', [routeId]);
    const plan = this.activePlans.get(Number(tripId)) || {};

    const openIncidents = await dbQuery(
      `SELECT i.*, s.name as student_name, st.name as stop_name
       FROM incidents i
       LEFT JOIN students s ON i.student_id = s.id
       LEFT JOIN stops st ON i.stop_id = st.id
       WHERE i.trip_id = ? AND i.status IN ('OPEN', 'ASSIGNED')`,
      [tripId]
    );

    const stopBreakdown = [];
    for (const st of stops) {
      const expected = plan[st.id] || [];
      const exited = await dbQuery(
        `SELECT be.*, s.name as student_name FROM boarding_events be
         JOIN students s ON be.student_id = s.id
         WHERE be.trip_id = ? AND be.stop_id = ? AND be.type = 'EXIT'`,
        [tripId, st.id]
      );
      const exitedIds = new Set(exited.map(e => e.student_id));
      const pending = expected.filter(e => !exitedIds.has(e.student_id));

      stopBreakdown.push({
        stop_id: st.id,
        stop_name: st.name,
        sequence: st.sequence,
        is_current: trip.current_stop_id === st.id,
        expected_count: expected.length,
        exited_count: exited.length,
        pending_count: pending.length,
        expected_students: expected,
        pending_students: pending
      });
    }

    return {
      success: true,
      trip_id: Number(tripId),
      status: trip.status,
      current_stop_id: trip.current_stop_id,
      open_incidents_count: openIncidents.length,
      open_incidents: openIncidents,
      stops: stopBreakdown
    };
  }

  /**
   * 7. Dashboard Incidents Queue with SLA Timer
   */
  async getDashboardIncidents(status = 'OPEN') {
    let sql = `
      SELECT i.*, s.name as student_name, s.class, st.name as stop_name, r.name as route_name
      FROM incidents i
      LEFT JOIN students s ON i.student_id = s.id
      LEFT JOIN stops st ON i.stop_id = st.id
      LEFT JOIN trips t ON i.trip_id = t.id
      LEFT JOIN routes r ON t.route_id = r.id
    `;
    const params = [];
    if (status && status !== 'ALL') {
      sql += ` WHERE i.status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY i.id DESC`;

    const rows = await dbQuery(sql, params);
    const now = Date.now();

    return rows.map(r => {
      const createdTs = new Date(r.created_at).getTime();
      const elapsedMinutes = Math.floor((now - createdTs) / 60000);
      const slaRemainingMinutes = Math.max(0, 15 - elapsedMinutes); // 15 min SLA

      return {
        ...r,
        elapsed_minutes: elapsedMinutes,
        sla_timer_minutes: slaRemainingMinutes,
        sla_breached: elapsedMinutes > 15
      };
    });
  }

  /**
   * 8. Trip End: Final Reconciliation Across All Stops
   * Unresolved = HIGH severity.
   */
  async endTrip({ tripId, actorId = 'DRIVER-01' }) {
    const trip = await dbGet('SELECT * FROM trips WHERE id = ?', [tripId]);
    if (!trip) throw new Error(`Trip ${tripId} not found.`);

    // Check all open incidents
    const openIncidents = await dbQuery(
      `SELECT * FROM incidents WHERE trip_id = ? AND status IN ('OPEN', 'ASSIGNED')`,
      [tripId]
    );

    // Escalate all open incidents to HIGH severity on trip completion
    if (openIncidents.length > 0) {
      await dbRun(
        `UPDATE incidents SET severity = 'HIGH' WHERE trip_id = ? AND status IN ('OPEN', 'ASSIGNED')`,
        [tripId]
      );
    }

    const finalStatus = openIncidents.length > 0 ? 'COMPLETED_WITH_INCIDENTS' : 'COMPLETED';
    await dbRun(
      `UPDATE trips SET status = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [finalStatus, tripId]
    );

    await this.logAudit({
      actorId,
      action: 'TRIP_END',
      entity: 'TRIP',
      entityId: tripId,
      reason: `Trip ended with status ${finalStatus}. Unresolved incidents: ${openIncidents.length}.`
    });

    return {
      success: true,
      trip_id: Number(tripId),
      status: finalStatus,
      unresolved_incidents_count: openIncidents.length,
      unresolved_incidents: openIncidents
    };
  }

  /**
   * 9. Edge Case: Offline Mode Synchronization
   * Queue events locally, reconcile locally against cached plan, sync later.
   * If server state disagrees, create conflict incident.
   */
  async handleOfflineSync({ tripId, events = [], actorId = 'DEV-BUS-01' }) {
    const syncedEvents = [];
    const conflictIncidents = [];

    for (const ev of events) {
      const idempotencyKey = this.generateIdempotencyKey(tripId, ev.student_id, ev.type, ev.stop_id, ev.timestamp);
      const existing = await dbGet('SELECT * FROM boarding_events WHERE idempotency_key = ?', [idempotencyKey]);

      if (!existing) {
        // Insert event marked as synced = 1
        const deviceId = ev.device_id || actorId || 'DEV-BUS-01';
        const ins = await dbRun(
          `INSERT INTO boarding_events (trip_id, student_id, type, method, stop_id, timestamp, device_id, synced, idempotency_key, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [tripId, ev.student_id, ev.type, ev.method || 'MANUAL', ev.stop_id, ev.timestamp, deviceId, idempotencyKey, ev.reason || 'Offline synced']
        );
        syncedEvents.push({ id: ins.id, student_id: ev.student_id, type: ev.type });

        // Conflict check: was an override or incident already closed on server with different state?
        const priorOverride = await dbGet(
          `SELECT * FROM incidents WHERE trip_id = ? AND student_id = ? AND status = 'OVERRIDE'`,
          [tripId, ev.student_id]
        );
        if (priorOverride && ev.type === 'EXIT') {
          // Conflict: School admin had already forced an override while bus was offline
          const confInc = await dbRun(
            `INSERT INTO incidents (trip_id, student_id, stop_id, type, severity, status, assigned_to, resolution_reason)
             VALUES (?, ?, ?, 'OFFLINE_CONFLICT', 'MEDIUM', 'OPEN', 'ADMIN', ?)`,
            [tripId, ev.student_id, ev.stop_id, 'Conflict: Local offline exit synced after admin override on server. Attendant verification required.']
          );
          conflictIncidents.push({ incident_id: confInc.id, student_id: ev.student_id });
        }
      }
    }

    await this.logAudit({
      actorId,
      action: 'OFFLINE_SYNC',
      entity: 'TRIP',
      entityId: tripId,
      reason: `Offline sync completed: ${syncedEvents.length} events synced, ${conflictIncidents.length} conflicts created.`
    });

    return {
      success: true,
      trip_id: Number(tripId),
      synced_count: syncedEvents.length,
      synced_events: syncedEvents,
      conflicts_count: conflictIncidents.length,
      conflict_incidents: conflictIncidents
    };
  }

  /**
   * 10. Edge Case: Mid-Route Route Change
   * School updates mapping in expected_drops, system recalculates pending expected list.
   */
  async handleMidRouteUpdate({ tripId, studentId, oldStopId, newStopId, actorId = 'ADMIN' }) {
    await dbRun(
      `UPDATE expected_drops SET stop_id = ? WHERE student_id = ? AND stop_id = ?`,
      [newStopId, studentId, oldStopId]
    );

    // Refresh active in-memory plan
    const plan = this.activePlans.get(Number(tripId));
    if (plan) {
      if (plan[oldStopId]) {
        plan[oldStopId] = plan[oldStopId].filter(s => s.student_id !== Number(studentId));
      }
      if (!plan[newStopId]) plan[newStopId] = [];
      const student = await dbGet('SELECT * FROM students WHERE id = ?', [studentId]);
      if (student) {
        plan[newStopId].push({
          student_id: student.id,
          student_name: student.name,
          class: student.class,
          guardian_id: student.guardian_id
        });
      }
    }

    await this.logAudit({
      actorId,
      action: 'PLAN_CHANGE',
      entity: 'STUDENT',
      entityId: studentId,
      reason: `Mid-route stop remapped from stop ${oldStopId} to stop ${newStopId}.`
    });

    return {
      success: true,
      trip_id: Number(tripId),
      student_id: Number(studentId),
      old_stop_id: oldStopId,
      new_stop_id: newStopId
    };
  }
}

// Singleton instance
const reconciliationEngine = new ReconciliationEngine();

module.exports = {
  ReconciliationEngine,
  reconciliationEngine
};
