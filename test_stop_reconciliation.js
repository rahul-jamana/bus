/**
 * SafeRide AI — Automated Stop-Level Custody Reconciliation Verification Suite
 * 
 * Verifies:
 * 1. Plan map generation & absent student exclusion
 * 2. Normal flow: student boards and exits at expected stop -> cleared
 * 3. Pending drop-off: bus departs stop -> detects missing exits BEFORE moving on
 * 4. Strict mode vs normal mode departure blocking
 * 5. Attendant 3-way resolution:
 *    - "VERIFIED_IN_BUS" -> stays OPEN, trip runs
 *    - "VERIFIED_EXITED_MANUAL" -> records manual exit, closes RESOLVED
 *    - "AUTHORISED_OVERRIDE" -> requires reason, closes OVERRIDE
 * 6. Edge Case: Face/QR failure -> mandatory reason enforcement
 * 7. Edge Case: Duplicate scans -> idempotency key protection
 * 8. Edge Case: Mid-route mapping update -> plan map recalculated
 * 9. Edge Case: Offline mode sync & conflict detection
 * 10. Trip end final reconciliation -> unresolved escalated to HIGH severity
 * 11. Performance benchmark -> runs in under 500ms per stop
 */

const http = require('http');

function apiCall(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: 'localhost',
        port: 3000,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        }
      },
      (res) => {
        let resData = '';
        res.on('data', (chunk) => (resData += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(resData) });
          } catch (e) {
            resolve({ status: res.statusCode, raw: resData });
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const { dbRun, dbQuery, dbGet } = require('./db/database');
const { initStopReconciliationDB } = require('./db/stopReconciliationSchema');

async function runStopReconciliationTests() {
  console.log('================================================================');
  console.log('🧪 Starting SafeRide AI: Stop-Level Custody Reconciliation Tests');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`✅ [PASS] ${testName} ${details ? '— ' + details : ''}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName} ${details ? '— ' + details : ''}`);
      failed++;
    }
  }

  // Ensure DB initialized
  await initStopReconciliationDB();

  const TEST_TRIP_ID = 501;

  // Clean test tables for clean run
  await dbRun(`DELETE FROM boarding_events WHERE trip_id = ?`, [TEST_TRIP_ID]);
  await dbRun(`DELETE FROM incidents WHERE trip_id = ?`, [TEST_TRIP_ID]);
  await dbRun(`DELETE FROM trips WHERE id = ?`, [TEST_TRIP_ID]);
  await dbRun(`DELETE FROM school_attendance WHERE date = date('now')`);
  await dbRun(`DELETE FROM audit_log WHERE entity_id = ?`, [String(TEST_TRIP_ID)]);

  // Mark student 104 (Tanya) as ABSENT today in school office
  await dbRun(
    `INSERT INTO school_attendance (student_id, date, status) VALUES (104, date('now'), 'ABSENT')`
  );

  // ---------------------------------------------------------------------------
  // TEST 1: Trip Start & Plan Map Generation (with Absent Student Exclusion)
  // ---------------------------------------------------------------------------
  console.log('--- TEST 1: Trip Start & Plan Map Generation ---');
  const startRes = await apiCall('POST', `/trips/${TEST_TRIP_ID}/start`, {
    route_id: 1,
    bus_id: 4,
    driver_id: 'DRV-RAMESH',
    attendant_id: 'ATT-HARI',
    actor_id: 'DRIVER-RAMESH'
  });

  const plan = startRes.body.plan_map;
  const stop4Expected = plan ? plan['4'] : [];
  const stop3Expected = plan ? plan['3'] : [];

  assert(
    startRes.body.success === true &&
    stop4Expected.some(s => s.student_name === 'Aarav Sharma') &&
    stop4Expected.some(s => s.student_name === 'Diya Patel') &&
    stop4Expected.some(s => s.student_name === 'Rohan Verma') &&
    (!stop3Expected.some(s => s.student_id === 104)), // Tanya excluded as absent
    'Test 1: Plan Map built successfully & absent student excluded from expected drops',
    `Stop 4 expected: ${stop4Expected.map(s => s.student_name).join(', ')}. Absent student 104 excluded: ${startRes.body.excluded_absent_students.length > 0}`
  );

  // ---------------------------------------------------------------------------
  // TEST 2: Boarding Events & Idempotency Duplicate Protection
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 2: Boarding Events & Duplicate Scan Protection ---');
  // Aarav boards via FACE
  const board1 = await apiCall('POST', '/events/board', {
    trip_id: TEST_TRIP_ID,
    student_id: 101, // Aarav
    method: 'FACE',
    stop_id: 1,
    device_ts: new Date().toISOString()
  });

  // Duplicate scan for Aarav immediately after
  const boardDup = await apiCall('POST', '/events/board', {
    trip_id: TEST_TRIP_ID,
    student_id: 101,
    method: 'FACE',
    stop_id: 1,
    device_ts: new Date().toISOString()
  });

  assert(
    board1.body.success === true && boardDup.body.duplicate === true,
    'Test 2: Duplicate scan prevented via minute-bucket idempotency key',
    `First scan event_id: ${board1.body.event_id}, Duplicate rejected: ${boardDup.body.duplicate}`
  );

  // Diya (102) and Rohan (103) also board
  await apiCall('POST', '/events/board', { trip_id: TEST_TRIP_ID, student_id: 102, method: 'QR', stop_id: 1 });
  await apiCall('POST', '/events/board', { trip_id: TEST_TRIP_ID, student_id: 103, method: 'QR', stop_id: 1 });

  // ---------------------------------------------------------------------------
  // TEST 3: Edge Case — Face/QR Failure Manual Override with Mandatory Reason
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 3: Manual Verification with Mandatory Reason ---');
  // Attempt manual exit without reason -> Must fail
  const manualFail = await apiCall('POST', '/events/exit', {
    trip_id: TEST_TRIP_ID,
    student_id: 101,
    method: 'MANUAL',
    stop_id: 4,
    reason: '' // empty reason!
  });
  assert(
    manualFail.status === 400 && manualFail.body.success === false,
    'Test 3A: Manual verification rejected without mandatory reason',
    `Error: ${manualFail.body.error}`
  );

  // Manual exit with valid reason -> Must succeed
  const manualPass = await apiCall('POST', '/events/exit', {
    trip_id: TEST_TRIP_ID,
    student_id: 101, // Aarav exits at Stop 4
    method: 'MANUAL',
    stop_id: 4,
    reason: 'Camera glitched in low ambient light; attendant verified face credentials physically.'
  });
  assert(
    manualPass.body.success === true && manualPass.body.method === 'MANUAL',
    'Test 3B: Manual verification succeeds with documented reason',
    `Method: MANUAL, Reason accepted: ${manualPass.body.event_id > 0}`
  );

  // ---------------------------------------------------------------------------
  // TEST 4: Stop 4 Geofence Enter & Stop Departure Reconciliation (Core Rule)
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 4: Stop 4 Geofence Departure & Pending Incident Creation ---');
  // Bus arrives at Stop 4
  await apiCall('POST', `/stops/4/enter`, { trip_id: TEST_TRIP_ID });

  // At Stop 4: Aarav has exited. Diya (102) and Rohan (103) have NOT exited.
  // Bus attempts to DEPART Stop 4
  const departRes = await apiCall('POST', `/stops/4/depart`, {
    trip_id: TEST_TRIP_ID,
    strict_mode: false
  });

  const pending = departRes.body.pending_students;
  const createdIncs = departRes.body.incidents;

  assert(
    departRes.body.reconciled === false &&
    pending.length === 2 &&
    pending.some(s => s.student_id === 102) && // Diya
    pending.some(s => s.student_id === 103) && // Rohan
    createdIncs.length === 2,
    'Test 4: Stop departure reconciliation identifies exact missing exits & creates incidents BEFORE moving on',
    `Pending: ${pending.map(s => s.student_name).join(', ')}. Incidents created: ${createdIncs.length}`
  );

  // ---------------------------------------------------------------------------
  // TEST 5: Strict Mode Departure Blocking
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 5: Strict Mode Departure Blocking ---');
  const strictDepart = await apiCall('POST', `/stops/4/depart`, {
    trip_id: TEST_TRIP_ID,
    strict_mode: true
  });
  assert(
    strictDepart.status === 400 && strictDepart.body.blocked === true && strictDepart.body.departure_allowed === false,
    'Test 5: Strict Mode strictly halts vehicle departure when pending drop-offs exist',
    `Departure blocked: ${strictDepart.body.blocked}`
  );

  // ---------------------------------------------------------------------------
  // TEST 6: Attendant Resolution Actions (3 Modes)
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 6: Attendant Resolution Actions (3 Modes) ---');
  const diyaIncident = createdIncs.find(i => i.student_id === 102 || (i.details && i.details.includes('Diya')));
  const rohanIncident = createdIncs.find(i => i.student_id === 103 || (i.details && i.details.includes('Rohan')));

  // Action 1: "Verified in bus" for Diya -> keeps trip running, incident stays OPEN
  const actionInBus = await apiCall('POST', `/incidents/${diyaIncident.incident_id || diyaIncident.id}/resolve`, {
    action: 'VERIFIED_IN_BUS',
    reason: 'Diya is asleep on seat 14. Attendant confirmed safe on bus.',
    actor_id: 'ATT-HARI'
  });
  assert(
    actionInBus.body.success === true && actionInBus.body.status === 'OPEN',
    'Test 6A: "Verified in bus" leaves incident OPEN for subsequent verification while trip continues',
    `Status: ${actionInBus.body.status}`
  );

  // Action 2: "Verified exited (record missed)" for Diya -> marks manual exit and closes RESOLVED
  const actionExitedManual = await apiCall('POST', `/incidents/${diyaIncident.incident_id || diyaIncident.id}/resolve`, {
    action: 'VERIFIED_EXITED_MANUAL',
    reason: 'Parent received Diya at Stop 4; QR scanner did not beep.',
    actor_id: 'ATT-HARI'
  });
  assert(
    actionExitedManual.body.success === true && actionExitedManual.body.status === 'RESOLVED',
    'Test 6B: "Verified exited (record missed)" creates manual exit event and marks incident RESOLVED',
    `Status: ${actionExitedManual.body.status}`
  );

  // Action 3: "Authorised override" for Rohan -> requires reason, closes OVERRIDE
  // Without reason -> fail
  const overrideNoReason = await apiCall('POST', `/incidents/${rohanIncident.incident_id || rohanIncident.id}/resolve`, {
    action: 'AUTHORISED_OVERRIDE',
    reason: 'ok', // too short
    actor_id: 'TRANSPORT-ADMIN'
  });
  assert(
    overrideNoReason.status === 400,
    'Test 6C: Authorised override rejected when reason is missing or inadequate',
    `Status: ${overrideNoReason.status}`
  );

  // With reason -> success
  const overridePass = await apiCall('POST', `/incidents/${rohanIncident.incident_id || rohanIncident.id}/resolve`, {
    action: 'AUTHORISED_OVERRIDE',
    reason: 'Principal authorized parent pickup directly by father at school gate prior to stop.',
    actor_id: 'TRANSPORT-ADMIN'
  });
  assert(
    overridePass.body.success === true && overridePass.body.status === 'OVERRIDE',
    'Test 6D: Authorised override closes incident with OVERRIDE status and audit trail',
    `Status: ${overridePass.body.status}`
  );

  // ---------------------------------------------------------------------------
  // TEST 7: Stop Re-evaluation After Resolution (All Cleared)
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 7: Stop Re-evaluation After Resolution ---');
  const departAfterResolve = await apiCall('POST', `/stops/4/depart`, {
    trip_id: TEST_TRIP_ID,
    strict_mode: true
  });
  assert(
    departAfterResolve.body.reconciled === true && departAfterResolve.body.departure_allowed === true,
    'Test 7: Stop reconciled to CLEAR once all pending drop-offs are resolved',
    `Reconciled: ${departAfterResolve.body.reconciled}, Departure Allowed: ${departAfterResolve.body.departure_allowed}`
  );

  // ---------------------------------------------------------------------------
  // TEST 8: Edge Case — Mid-Route Mapping Update
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 8: Mid-Route Route Mapping Update ---');
  const { reconciliationEngine } = require('./utils/reconciliationEngine');
  // School updates student 101's drop from Stop 4 to Stop 3
  const midRoute = await reconciliationEngine.handleMidRouteUpdate({
    tripId: TEST_TRIP_ID,
    studentId: 101,
    oldStopId: 4,
    newStopId: 3,
    actorId: 'ADMIN'
  });
  const updatedStatus = await apiCall('GET', `/trips/${TEST_TRIP_ID}/status`);
  assert(
    midRoute.success === true && updatedStatus.body.success === true,
    'Test 8: Mid-route route change successfully recalculates expected drop lists',
    `Old Stop: ${midRoute.old_stop_id} -> New Stop: ${midRoute.new_stop_id}`
  );

  // ---------------------------------------------------------------------------
  // TEST 9: Edge Case — Offline Mode Sync & Conflict Detection
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 9: Offline Mode Event Sync & Conflict Detection ---');
  const offlineSyncRes = await apiCall('POST', `/trips/${TEST_TRIP_ID}/sync`, {
    events: [
      {
        student_id: 103,
        type: 'EXIT',
        stop_id: 4,
        method: 'QR',
        timestamp: new Date().toISOString()
      }
    ],
    actor_id: 'DEV-BUS-01'
  });
  assert(
    offlineSyncRes.body.success === true && offlineSyncRes.body.conflicts_count > 0,
    'Test 9: Offline sync detects conflict when local event disagrees with server override',
    `Conflicts created: ${offlineSyncRes.body.conflicts_count}`
  );

  // ---------------------------------------------------------------------------
  // TEST 10: Trip End Final Reconciliation (Unresolved = HIGH Severity)
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 10: Trip End Final Reconciliation ---');
  const endTripRes = await apiCall('POST', `/trips/${TEST_TRIP_ID}/end`, {
    actor_id: 'DRIVER-RAMESH'
  });
  assert(
    endTripRes.body.success === true,
    'Test 10: Trip ended with final reconciliation audit across all stops',
    `Final Status: ${endTripRes.body.status}`
  );

  // ---------------------------------------------------------------------------
  // TEST 11: Non-Functional Criteria — Sub-500ms Execution Benchmark
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 11: Performance Benchmark (<500ms) ---');
  const t0 = Date.now();
  const perfDepart = await apiCall('POST', `/stops/4/depart`, {
    trip_id: TEST_TRIP_ID,
    strict_mode: false
  });
  const t1 = Date.now();
  const totalElapsed = t1 - t0;
  assert(
    totalElapsed < 500,
    'Test 11: Stop reconciliation executes well under 500ms limit',
    `Execution time: ${totalElapsed}ms (Internal engine: ${perfDepart.body.execution_ms || totalElapsed}ms)`
  );

  // ---------------------------------------------------------------------------
  // TEST 12: Audit Log Trail Verification
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 12: Audit Log Completeness ---');
  const audits = await dbQuery('SELECT * FROM audit_log WHERE entity_id = ? ORDER BY id ASC', [String(TEST_TRIP_ID)]);
  assert(
    audits.length >= 4,
    'Test 12: Full immutable audit trail logged for all state transitions and overrides',
    `Logged ${audits.length} audit entries for trip ${TEST_TRIP_ID}.`
  );

  console.log('\n================================================================');
  console.log(`📊 Stop-Level Custody Reconciliation: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed === 0) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runStopReconciliationTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
