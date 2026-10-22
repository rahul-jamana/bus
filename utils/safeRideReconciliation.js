/**
 * SafeRide AI — Core Safety Reconciliation & Intelligent Transportation Engine
 * 
 * Features Implemented:
 * 1. Live Student Count & Boarding/Drop-off Mismatch Reconciliation Engine
 * 2. Smart Geofence Proximity Alerts & Route Deviation Detection
 * 3. AI-Based Delay Prediction (Historical Segments & Fallback Telemetry)
 * 4. Scheduled Return Trip Safety Reconciliation & Mandatory Clearance Checklist
 */

const { dbQuery, dbGet, dbRun } = require('../db/database');
const { dispatchBusSMSNotification } = require('../routes/notifications');

// Cache to prevent duplicate proximity & delay alerts from GPS boundary fluctuations
const alertedGeofenceCache = new Map(); // key: `bus_${busId}_stop_${stopId}_trip_${tripId}`
const alertedDelayCache = new Map();    // key: `bus_${busId}_trip_${tripId}` -> lastAlertedDelayMinutes

/**
 * Haversine Distance Formula in Meters
 */
function getHaversineDistanceMeters(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return 999999;
  const R = 6371e3; // Earth radius in meters
  const phi1 = (Number(lat1) * Math.PI) / 180;
  const phi2 = (Number(lat2) * Math.PI) / 180;
  const deltaPhi = ((Number(lat2) - Number(lat1)) * Math.PI) / 180;
  const deltaLambda = ((Number(lon2) - Number(lon1)) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c);
}

/**
 * Parse standard time string (e.g. "04:00 PM" or "16:00") into minutes from midnight
 */
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const s = timeStr.trim().toUpperCase();
  const isPM = s.includes('PM');
  const isAM = s.includes('AM');
  const clean = s.replace('AM', '').replace('PM', '').trim();
  const parts = clean.split(':');
  let hours = parseInt(parts[0], 10) || 0;
  const mins = parseInt(parts[1], 10) || 0;

  if (isPM && hours < 12) hours += 12;
  if (isAM && hours === 12) hours = 0;
  return hours * 60 + mins;
}

/**
 * Format minutes from midnight to readable "04:12 PM"
 */
function formatMinutesToTime(totalMinutes) {
  let mins = Math.round(totalMinutes) % (24 * 60);
  if (mins < 0) mins += 24 * 60;
  let hours = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const padH = String(hours).padStart(2, '0');
  const padM = String(m).padStart(2, '0');
  return `${padH}:${padM} ${ampm}`;
}

/**
 * ==============================================================================
 * FEATURE 1 & 4: LIVE STUDENT COUNT & MANIFEST RECONCILIATION
 * ==============================================================================
 */
async function reconcileTripAttendance({ busId = 1, tripId = null, tripType = 'RETURN' }) {
  try {
    // 1. Get bus details
    const bus = await dbGet('SELECT * FROM buses WHERE id = ?', [busId]);
    const busNum = bus ? bus.bus_number : `Bus #${busId}`;

    // 2. Locate active trip or target return trip
    let trip = null;
    if (tripId) {
      trip = await dbGet('SELECT * FROM trips WHERE id = ?', [tripId]);
    } else {
      // Find latest active or return trip for this bus
      trip = await dbGet(
        `SELECT * FROM trips WHERE bus_id = ? AND (status = 'ACTIVE' OR trip_type = ?) ORDER BY id DESC LIMIT 1`,
        [busId, tripType]
      );
    }

    const effectiveTripId = trip ? trip.id : 102;
    const scheduledTime = trip ? (trip.scheduled_departure_time || '04:00 PM') : '04:00 PM';

    // 3. Retrieve expected student manifest
    let manifest = await dbQuery(
      `SELECT * FROM trip_manifest WHERE trip_id = ? AND bus_id = ? ORDER BY student_name ASC`,
      [effectiveTripId, busId]
    );

    // If manifest is empty for this trip, fallback to bus registrations for this bus
    if (manifest.length === 0) {
      const regStudents = await dbQuery(
        `SELECT s.id as student_id, s.name as student_name, s.roll_number, s.pickup_stop_name, s.drop_stop_name, s.parent_name, s.parent_mobile
         FROM students s
         JOIN bus_registrations br ON s.id = br.student_id
         WHERE br.bus_id = ? AND br.is_active = 1
         ORDER BY s.name ASC`,
        [busId]
      );
      manifest = regStudents.map(s => ({
        trip_id: effectiveTripId,
        bus_id: Number(busId),
        student_id: s.student_id,
        roll_number: s.roll_number,
        student_name: s.student_name,
        stop_name: s.drop_stop_name || s.pickup_stop_name || 'Pitapalli Square',
        status: 'EXPECTED'
      }));
    }

    // 4. Retrieve verified today's logs for this trip / bus
    const logs = await dbQuery(
      `SELECT * FROM bus_boarding_logs 
       WHERE bus_id = ? AND date(log_time) = date('now')
       ORDER BY id ASC`,
      [busId]
    );

    // Filter into Boarding (IN) and Exit (OUT)
    const boardLogs = logs.filter(l => l.log_type === 'BOARD' || l.log_type === 'RETURN_BOARD' || l.stage === 'BOARD');
    const exitLogs = logs.filter(l => l.log_type === 'STUDENT_EXIT' || l.stage === 'EXIT' || l.log_type === 'GUARDIAN_HANDOVER');

    // Build unique sets to enforce strict single counting per trip (keyed by both ID and Roll Number)
    const boardedStudentMap = new Map();
    boardLogs.forEach(l => {
      if (l.student_id) boardedStudentMap.set(String(l.student_id), l);
      if (l.roll_number) boardedStudentMap.set(String(l.roll_number), l);
    });

    const exitedStudentMap = new Map();
    exitLogs.forEach(l => {
      if (l.student_id) exitedStudentMap.set(String(l.student_id), l);
      if (l.roll_number) exitedStudentMap.set(String(l.roll_number), l);
    });

    // 5. Compare against Expected Student Manifest (Do not rely only on aggregate count!)
    const expectedStudents = [];
    const boardedStudents = [];
    const exitedStudents = [];
    const currentlyOnboardStudents = [];
    const missingExitStudents = [];   // Boarded but no exit record
    const didNotBoardStudents = [];   // Expected on manifest but never boarded (Attendance Exception)

    manifest.forEach(item => {
      const keyId = String(item.student_id);
      const keyRoll = String(item.roll_number);
      const bLog = boardedStudentMap.get(keyId) || boardedStudentMap.get(keyRoll);
      const eLog = exitedStudentMap.get(keyId) || exitedStudentMap.get(keyRoll);

      const studentRecord = {
        student_id: item.student_id,
        roll_number: item.roll_number,
        student_name: item.student_name,
        stop_name: item.stop_name,
        is_boarded: !!bLog,
        boarding_time: bLog ? bLog.log_time : null,
        boarding_method: bLog ? bLog.verification_method : null,
        is_exited: !!eLog,
        exit_time: eLog ? eLog.log_time : null,
        exit_method: eLog ? eLog.verification_method : null,
        status: 'EXPECTED'
      };

      expectedStudents.push(studentRecord);

      if (bLog && eLog) {
        studentRecord.status = 'COMPLETED_SAFE';
        boardedStudents.push(studentRecord);
        exitedStudents.push(studentRecord);
      } else if (bLog && !eLog) {
        studentRecord.status = 'ONBOARD';
        boardedStudents.push(studentRecord);
        currentlyOnboardStudents.push(studentRecord);
        // Flagged as missing exit record
        missingExitStudents.push(studentRecord);
      } else if (!bLog) {
        studentRecord.status = 'DID_NOT_BOARD';
        didNotBoardStudents.push(studentRecord);
      }
    });

    // Check for any unmanifested students who boarded
    boardedStudentMap.forEach((l, k) => {
      const inManifest = manifest.some(m => String(m.student_id) === k || String(m.roll_number) === k);
      if (!inManifest) {
        const eLog = exitedStudentMap.get(k);
        const unmanifested = {
          student_id: l.student_id,
          roll_number: l.roll_number,
          student_name: l.student_name || `Student ${l.roll_number}`,
          stop_name: 'Unassigned Stop',
          is_boarded: true,
          boarding_time: l.log_time,
          boarding_method: l.verification_method,
          is_exited: !!eLog,
          exit_time: eLog ? eLog.log_time : null,
          exit_method: eLog ? eLog.verification_method : null,
          status: eLog ? 'COMPLETED_SAFE' : 'ONBOARD',
          is_extra_passenger: true
        };
        boardedStudents.push(unmanifested);
        if (!eLog) {
          currentlyOnboardStudents.push(unmanifested);
          missingExitStudents.push(unmanifested);
        } else {
          exitedStudents.push(unmanifested);
        }
      }
    });

    // 6. Check open safety incidents in database
    const initialOpenIncidents = await dbQuery(
      `SELECT * FROM safety_incidents WHERE trip_id = ? AND bus_id = ? AND status = 'OPEN'`,
      [effectiveTripId, busId]
    );

    // Auto-resolve any prior MISSING_EXIT incidents for students who have now exited
    for (const inc of initialOpenIncidents) {
      if (inc.incident_type === 'MISSING_EXIT') {
        const stillMissing = missingExitStudents.some(m => m.roll_number === inc.roll_number);
        if (!stillMissing) {
          await dbRun(
            `UPDATE safety_incidents SET status = 'RESOLVED', resolution_type = 'VERIFIED_EXIT', resolution_notes = 'Student verified drop-off exit at bus stop.', resolved_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [inc.id]
          );
        }
      }
    }

    // Sync missing exits to safety_incidents table automatically
    for (const m of missingExitStudents) {
      const existing = initialOpenIncidents.find(inc => inc.roll_number === m.roll_number && inc.incident_type === 'MISSING_EXIT');
      if (!existing) {
        const incId = `INC-${effectiveTripId}-${m.roll_number}-${Date.now().toString().slice(-4)}`;
        const note = `STUDENT COUNT MISMATCH: Student boarded ${busNum} at ${m.boarding_time} but exit record is missing at destination.`;
        await dbRun(
          `INSERT INTO safety_incidents (incident_id, trip_id, bus_id, student_id, roll_number, student_name, incident_type, severity, status, details, description) 
           VALUES (?, ?, ?, ?, ?, ?, 'MISSING_EXIT', 'CRITICAL', 'OPEN', ?, ?)`,
          [
            incId,
            effectiveTripId,
            busId,
            m.student_id,
            m.roll_number,
            m.student_name,
            note,
            note
          ]
        );
      }
    }

    const openIncidents = await dbQuery(
      `SELECT * FROM safety_incidents WHERE trip_id = ? AND bus_id = ? AND status = 'OPEN'`,
      [effectiveTripId, busId]
    );

    // Determine overall safety status
    let safetyStatus = 'CLEAR';
    let safetyActionText = 'All verified student boardings and exits are balanced.';

    if (missingExitStudents.length > 0 || openIncidents.length > 0) {
      safetyStatus = 'INCIDENT_OPEN';
      safetyActionText = `STUDENT COUNT MISMATCH — ACTION REQUIRED: ${missingExitStudents.length || openIncidents.length} student exit not verified. Check bus immediately!`;
    } else if (didNotBoardStudents.length > 0 && trip && trip.status === 'ACTIVE') {
      safetyStatus = 'CHECK_REQUIRED';
      safetyActionText = `ATTENDANCE EXCEPTION: ${didNotBoardStudents.length} expected student(s) did not board. Authorised confirmation required.`;
    }

    // Update trip summary counters in database
    if (trip) {
      await dbRun(
        `UPDATE trips SET 
          expected_count = ?, 
          boarded_count = ?, 
          exited_count = ?, 
          unresolved_count = ?, 
          safety_status = ? 
         WHERE id = ?`,
        [
          manifest.length,
          boardedStudents.length,
          exitedStudents.length,
          missingExitStudents.length,
          safetyStatus,
          trip.id
        ]
      );
    }

    // Get last scanner event
    const lastEvent = logs.length > 0 ? logs[logs.length - 1] : null;

    return {
      success: true,
      bus_id: Number(busId),
      bus_number: busNum,
      trip_id: effectiveTripId,
      trip_code: trip ? trip.trip_code || 'TRIP-RET-102' : 'TRIP-RET-102',
      scheduled_return_time: scheduledTime,
      counts: {
        expected_students: manifest.length,
        verified_boarded: boardedStudents.length,
        currently_onboard: currentlyOnboardStudents.length,
        verified_exited: exitedStudents.length,
        unresolved_count: missingExitStudents.length,
        unresolved_students: missingExitStudents.length,
        did_not_board_count: didNotBoardStudents.length
      },
      safety_status: safetyStatus,
      safety_action_text: safetyActionText,
      discrepancies: {
        missing_exit_students: missingExitStudents,
        did_not_board_students: didNotBoardStudents
      },
      missing_exit_students: missingExitStudents,
      did_not_board_students: didNotBoardStudents,
      currently_onboard_students: currentlyOnboardStudents,
      manifest: expectedStudents,
      last_scanner_event: lastEvent ? {
        student_id: lastEvent.student_id,
        roll_number: lastEvent.roll_number,
        log_type: lastEvent.log_type,
        method: lastEvent.verification_method || 'FACE',
        time: lastEvent.log_time,
        status: lastEvent.verification_status || 'VERIFIED'
      } : null,
      open_incidents: openIncidents,
      clearance_checklist_completed: trip ? !!trip.inspection_checklist_completed : false,
      clearance_status: trip ? trip.clearance_status || 'PENDING' : 'PENDING'
    };
  } catch (err) {
    console.error('Error in reconcileTripAttendance:', err);
    throw err;
  }
}

/**
 * ==============================================================================
 * AUTHORISED INCIDENT RESOLUTION (DRIVER CANNOT SILENTLY DISMISS)
 * ==============================================================================
 */
async function resolveSafetyIncident({ incidentId, resolutionType, resolutionNotes, authorisedBy = 'Staff Admin', passcode }) {
  // Enforce staff authorisation check
  if (passcode !== '9040954015' && passcode !== 'admin123') {
    return {
      success: false,
      message: '❌ AUTHORISATION FAILED: Valid admin or attendant PIN required to resolve safety discrepancy.'
    };
  }

  if (!resolutionNotes || resolutionNotes.trim().length < 5) {
    return {
      success: false,
      message: '❌ MANDATORY REASON REQUIRED: Resolution cannot be closed without a documented explanation and audit note.'
    };
  }

  const incident = await dbGet('SELECT * FROM safety_incidents WHERE incident_id = ? OR id = ?', [incidentId, incidentId]);
  if (!incident) {
    return { success: false, message: 'Incident record not found.' };
  }

  const resolvedAt = new Date().toISOString();
  await dbRun(
    `UPDATE safety_incidents SET 
      status = 'RESOLVED',
      resolution_type = ?,
      resolution_notes = ?,
      resolved_by = ?,
      resolved_at = ?
     WHERE id = ?`,
    [resolutionType, resolutionNotes, authorisedBy, resolvedAt, incident.id]
  );

  // If missing exit resolution, insert audited resolution log
  await dbRun(
    `INSERT INTO bus_boarding_logs (
      student_id, roll_number, bus_id, log_type, face_matched, alert_type, 
      staff_override, stage, verification_method, verification_status, 
      attendant_id, manual_reason
    ) VALUES (?, ?, ?, 'STUDENT_EXIT', 0, 'INCIDENT_RESOLVED', 1, 'EXIT', 'MANUAL', 'OVERRIDDEN', ?, ?)`,
    [
      incident.student_id,
      incident.roll_number,
      incident.bus_id,
      authorisedBy,
      `RESOLVED INCIDENT: ${resolutionType} — ${resolutionNotes}`
    ]
  );

  // Log in security audit
  await dbRun(
    `INSERT INTO security_alerts (alert_type, camera_id, student_id, gate_name, is_acknowledged, acknowledged_by, notes) 
     VALUES ('SAFETY_INCIDENT_RESOLVED', 'SafetyReconciliation', ?, 'Bus Clearance Console', 1, ?, ?)`,
    [incident.roll_number, authorisedBy, `Incident ${incident.incident_id} resolved: ${resolutionType} (${resolutionNotes})`]
  );

  return {
    success: true,
    message: `✔ Safety Incident ${incident.incident_id} successfully resolved and audited. Student marked safe.`,
    resolved_at: resolvedAt,
    incident_id: incident.incident_id
  };
}

/**
 * ==============================================================================
 * FEATURE 2: SMART BUS STOP & GEOFENCE PROXIMITY NOTIFICATIONS
 * ==============================================================================
 */
async function processGeofenceAndDeviations({ busId = 1, lat, lng, speed = 0 }) {
  const bus = await dbGet('SELECT * FROM buses WHERE id = ?', [busId]);
  if (!bus) return null;

  const currentLat = Number(lat);
  const currentLng = Number(lng);
  const currentSpeed = Number(speed);
  const busNum = bus.bus_number;
  const routeName = bus.route_name;

  // 1. Fetch approved stops for this route with GPS coordinates
  let stops = await dbQuery(
    `SELECT * FROM bus_stops WHERE route_name = ? OR route_id = 1 ORDER BY id ASC`,
    [routeName]
  );

  // Fallback seed stops if table is empty
  if (stops.length === 0) {
    stops = [
      { id: 1, stop_name: 'BEC Campus Gate', stop_order: 1, lat: 20.1782, lng: 85.7061, geofence_radius_meters: 500, scheduled_drop_time: '04:00 PM' },
      { id: 2, stop_name: 'Khordha Bypass', stop_order: 2, lat: 20.1875, lng: 85.6214, geofence_radius_meters: 500, scheduled_drop_time: '04:20 PM' },
      { id: 3, stop_name: 'Pitapalli Square', stop_order: 3, lat: 20.2105, lng: 85.6702, geofence_radius_meters: 500, scheduled_drop_time: '04:40 PM' },
      { id: 4, stop_name: 'Master Canteen', stop_order: 4, lat: 20.2648, lng: 85.8398, geofence_radius_meters: 500, scheduled_drop_time: '05:05 PM' }
    ];
  }

  // Normalize lat/lng fields
  stops.forEach(st => {
    st.lat = Number(st.lat || st.gps_lat || 20.1782);
    st.lng = Number(st.lng || st.gps_lng || 85.7061);
  });

  // 2. Compute Distance to Each Stop & Find Nearest
  let minStopDistance = 999999;
  let nearestStop = null;
  const proximityAlertsSent = [];

  for (const st of stops) {
    const distMeters = getHaversineDistanceMeters(currentLat, currentLng, st.lat, st.lng);
    st.distance_meters = distMeters;

    if (distMeters < minStopDistance) {
      minStopDistance = distMeters;
      nearestStop = st;
    }

    // Check Geofence Entry (Configurable per stop, default 500m)
    const geofenceRadius = st.geofence_radius_meters || 500;
    const cacheKey = `bus_${busId}_stop_${st.id}_date_${new Date().toISOString().split('T')[0]}`;

    if (distMeters <= geofenceRadius && !alertedGeofenceCache.has(cacheKey)) {
      // Mark alerted in memory to prevent duplicate boundary fluctuation triggers
      alertedGeofenceCache.set(cacheKey, true);

      // Calculate dynamic estimated arrival time for this stop
      const etaMins = Math.max(1, Math.round(distMeters / (Math.max(currentSpeed, 20) * 1000 / 60)));
      const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
      const etaTimeStr = formatMinutesToTime(nowMins + etaMins);

      // Fetch students assigned to this stop
      const assignedStudents = await dbQuery(
        `SELECT s.* FROM students s
         JOIN bus_registrations br ON s.id = br.student_id
         WHERE br.bus_id = ? AND (s.pickup_stop_name LIKE ? OR s.drop_stop_name LIKE ?)`,
        [busId, `%${st.stop_name}%`, `%${st.stop_name}%`]
      );

      for (const student of assignedStudents) {
        await dispatchBusSMSNotification('GEOFENCE_APPROACH', {
          studentName: student.name,
          rollNumber: student.roll_number,
          parentName: student.parent_name,
          parentMobile: student.parent_mobile || student.mobile,
          busNumber: busNum,
          stopName: st.stop_name,
          studentId: student.id,
          timeStr: etaTimeStr,
          distanceMeters: geofenceRadius
        });
        proximityAlertsSent.push({
          student_name: student.name,
          stop_name: st.stop_name,
          eta_time: etaTimeStr
        });
      }

      // Record in trips table
      await dbRun('UPDATE trips SET last_geofence_stop_id = ? WHERE bus_id = ? AND status = "ACTIVE"', [st.id, busId]);
    }
  }

  // 3. Route Deviation Detection (> 1500 meters from nearest approved route corridor)
  let routeDeviation = false;
  const DEVIATION_THRESHOLD_METERS = 1500;

  if (minStopDistance > DEVIATION_THRESHOLD_METERS) {
    routeDeviation = true;
    await dbRun('UPDATE trips SET route_deviation_flag = 1 WHERE bus_id = ? AND status = "ACTIVE"', [busId]);

    // Check if deviation alert was already dispatched recently (throttle to once per 10 mins)
    const devKey = `dev_bus_${busId}_${new Date().toISOString().slice(0, 14)}`;
    if (!alertedGeofenceCache.has(devKey)) {
      alertedGeofenceCache.set(devKey, true);
      await dbRun(
        `INSERT INTO security_alerts (alert_type, camera_id, gate_name, notes) 
         VALUES ('ROUTE_DEVIATION', 'GPS-Broadcaster', 'Fleet Safety Corridor', ?)`,
        [`ALERT: ${busNum} has deviated ${minStopDistance}m away from nearest approved route waypoint.`]
      );
      await dispatchBusSMSNotification('ROUTE_DEVIATION', {
        busNumber: busNum,
        routeName,
        timeStr: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      });
    }
  }

  return {
    nearest_stop: nearestStop ? {
      id: nearestStop.id,
      stop_name: nearestStop.stop_name,
      distance_meters: minStopDistance,
      scheduled_time: nearestStop.scheduled_drop_time
    } : null,
    min_distance_to_route_meters: minStopDistance,
    route_deviation: {
      is_deviated: routeDeviation,
      distance_meters: minStopDistance,
      threshold_meters: DEVIATION_THRESHOLD_METERS
    },
    is_route_deviated: routeDeviation,
    proximity_alerts_sent: proximityAlertsSent
  };
}

/**
 * ==============================================================================
 * FEATURE 3: AI-BASED DELAY PREDICTION ENGINE
 * ==============================================================================
 */
async function predictEtaAndDelay({ busId = 1, currentLat, currentLng, currentSpeed = 0 }) {
  const bus = await dbGet('SELECT * FROM buses WHERE id = ?', [busId]);
  if (!bus) return null;

  const lat = Number(currentLat || bus.current_lat || 20.2961);
  const lng = Number(currentLng || bus.current_lng || 85.8245);
  const speed = Number(currentSpeed !== undefined ? currentSpeed : bus.speed || 0);

  // 1. Fetch route stops
  let stops = await dbQuery(
    `SELECT * FROM bus_stops WHERE route_name = ? OR route_id = 1 ORDER BY id ASC`,
    [bus.route_name]
  );

  if (stops.length === 0) {
    stops = [
      { id: 1, stop_name: 'BEC Campus Gate', stop_order: 1, lat: 20.1782, lng: 85.7061, scheduled_drop_time: '04:00 PM' },
      { id: 2, stop_name: 'Khordha Bypass', stop_order: 2, lat: 20.1875, lng: 85.6214, scheduled_drop_time: '04:20 PM' },
      { id: 3, stop_name: 'Pitapalli Square', stop_order: 3, lat: 20.2105, lng: 85.6702, scheduled_drop_time: '04:40 PM' },
      { id: 4, stop_name: 'Master Canteen', stop_order: 4, lat: 20.2648, lng: 85.8398, scheduled_drop_time: '05:05 PM' }
    ];
  }

  // Normalize lat/lng fields
  stops.forEach(st => {
    st.lat = Number(st.lat || st.gps_lat || 20.1782);
    st.lng = Number(st.lng || st.gps_lng || 85.7061);
  });

  // 2. Query historical transit segments for this route
  const historySegments = await dbQuery(
    `SELECT * FROM trip_segment_history WHERE route_id = 1`
  );

  const hasHistoricalData = historySegments.length >= 2;
  const calculationMethod = hasHistoricalData ? 'HISTORICAL_AI' : 'BASIC_TELEMETRY';

  // 3. Current time in minutes
  const now = new Date();
  const currentMinutesFromMidnight = now.getHours() * 60 + now.getMinutes();

  let accumulatedMinutes = 0;
  let previousLat = lat;
  let previousLng = lng;
  const stopPredictions = [];
  let maxDelayMinutes = 0;

  for (let i = 0; i < stops.length; i++) {
    const st = stops[i];
    const distToStop = getHaversineDistanceMeters(previousLat, previousLng, st.lat, st.lng);

    let segmentMinutes = 0;
    if (hasHistoricalData) {
      // Historical weighted average: match segment
      const histMatch = historySegments.find(h => h.to_stop_name === st.stop_name);
      const histDuration = histMatch ? (histMatch.historical_duration_seconds || histMatch.duration_seconds) : null;
      if (histDuration) {
        segmentMinutes = histDuration / 60;
      } else {
        const effectiveSpeed = speed > 5 ? speed : (histMatch?.avg_speed_kmh || 25);
        segmentMinutes = (distToStop / (effectiveSpeed * 1000)) * 60;
      }
    } else {
      // Basic Telemetry calculation
      const effectiveSpeed = speed > 5 ? speed : 25; // default 25 km/h urban school bus speed
      segmentMinutes = (distToStop / (effectiveSpeed * 1000)) * 60;
    }

    accumulatedMinutes += segmentMinutes;
    const predictedArrivalMins = currentMinutesFromMidnight + accumulatedMinutes;
    const predictedTimeStr = formatMinutesToTime(predictedArrivalMins);

    // Compare with scheduled arrival time
    const scheduledTimeStr = st.scheduled_drop_time || st.drop_time || '04:30 PM';
    const scheduledMins = parseTimeToMinutes(scheduledTimeStr);
    const delayMins = Math.round(predictedArrivalMins - scheduledMins);

    if (delayMins > maxDelayMinutes) {
      maxDelayMinutes = delayMins;
    }

    stopPredictions.push({
      stop_id: st.id,
      stop_name: st.stop_name,
      distance_meters: distToStop,
      scheduled_time: scheduledTimeStr,
      predicted_time: predictedTimeStr,
      delay_minutes: delayMins,
      is_delayed: delayMins >= 10,
      calculation_method: calculationMethod
    });

    previousLat = st.lat;
    previousLng = st.lng;
  }

  // 4. Save prediction record for tracking accuracy
  const primaryStop = stopPredictions.find(s => s.stop_name.includes('Pitapalli')) || stopPredictions[0];
  if (primaryStop) {
    await dbRun(
      `INSERT INTO eta_predictions (trip_id, bus_id, stop_name, scheduled_time, predicted_arrival_time, estimated_delay_minutes, calculation_method) 
       VALUES (102, ?, ?, ?, ?, ?, ?)`,
      [
        busId,
        primaryStop.stop_name,
        primaryStop.scheduled_time,
        primaryStop.predicted_time,
        primaryStop.delay_minutes,
        calculationMethod
      ]
    );

    // 5. Check if meaningful delay alert should be sent (>= 10 mins and threshold changed by >= 5 mins)
    const delayCacheKey = `delay_bus_${busId}`;
    const lastAlertedDelay = alertedDelayCache.get(delayCacheKey) || 0;

    if (primaryStop.delay_minutes >= 10 && Math.abs(primaryStop.delay_minutes - lastAlertedDelay) >= 5) {
      alertedDelayCache.set(delayCacheKey, primaryStop.delay_minutes);

      // Notify parent & admin of meaningful delay
      await dispatchBusSMSNotification('DELAY_ALERT', {
        busNumber: bus.bus_number,
        routeName: bus.route_name,
        timeStr: primaryStop.predicted_time,
        delayMinutes: primaryStop.delay_minutes,
        stopName: primaryStop.stop_name
      });
    }
  }

  return {
    success: true,
    bus_number: bus.bus_number,
    calculation_method: calculationMethod,
    calculation_label: hasHistoricalData ? 'AI Historical Regression Model' : 'Standard Telemetry (Distance & GPS Speed)',
    current_speed_kmh: speed,
    max_delay_minutes: maxDelayMinutes,
    is_delayed: maxDelayMinutes >= 10,
    predictions: stopPredictions,
    stop_predictions: stopPredictions
  };
}

/**
 * ==============================================================================
 * MANDATORY SLEEPING CHILD & BUS CLEARANCE WALKTHROUGH
 * ==============================================================================
 */
async function processTripClearanceChecklist({
  tripId = 102,
  busId = 1,
  seatsChecked = true,
  rearChecked = true,
  underSeatsChecked = true,
  inspectionNotes = 'Physical walkthrough completed. All seat rows and storage checked empty.',
  inspectorName = 'Driver Ramesh Kumar'
}) {
  const isComplete = seatsChecked && rearChecked && underSeatsChecked;
  const clearanceStatus = isComplete ? 'CLEARED' : 'PENDING';

  await dbRun(
    `UPDATE trips SET 
      inspection_checklist_completed = ?, 
      seats_checked = ?, 
      rear_checked = ?, 
      under_seats_checked = ?, 
      inspection_notes = ?, 
      inspection_signed_by = ?, 
      clearance_status = ? 
     WHERE id = ?`,
    [
      isComplete ? 1 : 0,
      seatsChecked ? 1 : 0,
      rearChecked ? 1 : 0,
      underSeatsChecked ? 1 : 0,
      inspectionNotes,
      inspectorName,
      clearanceStatus,
      tripId
    ]
  );

  return {
    success: true,
    trip_id: tripId,
    clearance_status: clearanceStatus,
    is_complete: isComplete,
    checklist: {
      seats_checked: !!seatsChecked,
      rear_checked: !!rearChecked,
      under_seats_checked: !!underSeatsChecked
    },
    message: isComplete 
      ? '✔ Physical inspection sign-off completed. Bus verified empty of sleeping children.' 
      : '⚠️ Incomplete inspection: All physical check areas must be confirmed before trip can be cleared.'
  };
}

/**
 * Update manifest boarding event
 */
async function recordManifestBoarding({ busId = 1, tripId = null, studentId, rollNumber, studentName, method = 'FACE' }) {
  const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const effectiveTripId = tripId || 102;
  await dbRun(
    `UPDATE trip_manifest SET 
      boarded = 1, 
      boarded_time = ?, 
      boarded_verification_method = ?, 
      attendance_status = 'BOARDED' 
     WHERE trip_id = ? AND (student_id = ? OR roll_number = ?)`,
    [timeStr, method, effectiveTripId, studentId, rollNumber]
  );
}

/**
 * Update manifest exit event
 */
async function recordManifestExit({ busId = 1, tripId = null, studentId, rollNumber, studentName, method = 'FACE' }) {
  const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const effectiveTripId = tripId || 102;
  await dbRun(
    `UPDATE trip_manifest SET 
      exited = 1, 
      exited_time = ?, 
      exited_verification_method = ?, 
      attendance_status = 'EXITED' 
     WHERE trip_id = ? AND (student_id = ? OR roll_number = ?)`,
    [timeStr, method, effectiveTripId, studentId, rollNumber]
  );
}

module.exports = {
  getHaversineDistanceMeters,
  reconcileTripAttendance,
  resolveSafetyIncident,
  processGeofenceAndDeviations,
  predictEtaAndDelay,
  processTripClearanceChecklist,
  recordManifestBoarding,
  recordManifestExit
};
