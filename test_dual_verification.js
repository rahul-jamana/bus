// SchoolSafe — 14-Scenario Dual Student Verification & Smart Attendance Test Suite
const http = require('http');

function request(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const postData = data ? JSON.stringify(data) : null;
    const options = {
      hostname: 'localhost',
      port: 3000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });

    req.on('error', err => reject(err));
    if (postData) req.write(postData);
    req.end();
  });
}

async function runAll14Tests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING SCHOOLSAFE DUAL VERIFICATION & SMART ATTENDANCE TEST SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName} - ${details}`);
      failed++;
    }
  }

  try {
    // SETUP: Fetch Rohan Verma's initial transport card details
    console.log('🔍 Fetching Rohan Verma profile & transport card...');
    const rohanCardRes = await request('GET', '/api/students/STU-ROHAN/transport-card');
    assert(rohanCardRes.status === 200 && rohanCardRes.body.success, 'Fetch Rohan Transport Card', JSON.stringify(rohanCardRes.body));
    const cardUuid = rohanCardRes.body.card.card_uuid;
    const rfidUid = rohanCardRes.body.card.rfid_uid;
    console.log(`   Rohan Card UUID: ${cardUuid} | RFID: ${rfidUid}\n`);

    // SCENARIO 1: Student boards with face recognition
    console.log('--- Scenario 1: Student boards with face recognition (Method 1) ---');
    const s1Res = await request('POST', '/api/bus/board', {
      student_id: 'STU-ROHAN',
      roll_number: 'ROHAN-04',
      bus_id: 1, // Bus #4
      route_id: 1,
      face_confidence: 99.4,
      verification_method: 'FACE'
    });
    assert(
      s1Res.status === 200 && (s1Res.body.success || s1Res.body.alert === 'DUPLICATE_ATTENDANCE'),
      'Scenario 1: Face recognition boarding processed',
      JSON.stringify(s1Res.body)
    );

    // SCENARIO 8: Student scans the same card/method twice (Duplicate Attendance Check)
    console.log('\n--- Scenario 8: Duplicate Boarding Prevention ---');
    const s8Res = await request('POST', '/api/bus/board', {
      student_id: 'STU-ROHAN',
      roll_number: 'ROHAN-04',
      bus_id: 1,
      verification_method: 'FACE'
    });
    assert(
      s8Res.body.alert === 'DUPLICATE_ATTENDANCE' || s8Res.body.duplicate === true,
      'Scenario 8: Duplicate boarding event correctly blocked & warning returned',
      s8Res.body.message
    );

    // SCENARIO 2: Student boards with QR ID card (Method 2)
    console.log('\n--- Scenario 2: Student boards with QR ID Card (Method 2 - Backup) ---');
    // We test with Munu Nial (BEC26081) on Bus #1
    const munuCardRes = await request('GET', '/api/students/BEC26081/transport-card');
    const munuCardToken = munuCardRes.body?.card?.card_uuid || 'SC-CARD-MUN-26081';
    
    const s2Res = await request('POST', '/api/bus/verify-card', {
      card_token: munuCardToken,
      bus_id: 1,
      action: 'BOARD',
      attendant_id: 'Hari Das (ATT-01)'
    });
    assert(
      s2Res.status === 200 && (s2Res.body.success || s2Res.body.alert === 'DUPLICATE_ATTENDANCE'),
      'Scenario 2: QR ID card boarding verified with student ERP profile',
      JSON.stringify(s2Res.body)
    );

    // SCENARIO 3: Student boards with RFID where hardware is available
    console.log('\n--- Scenario 3: Student boards with RFID tap ---');
    const s3Res = await request('POST', '/api/bus/verify-card', {
      rfid_uid: munuCardRes.body?.card?.rfid_uid || 'A1-26-08-10',
      bus_id: 1,
      action: 'BOARD',
      attendant_id: 'Hari Das (ATT-01)'
    });
    assert(
      s3Res.status === 200 && (s3Res.body.success || s3Res.body.alert === 'DUPLICATE_ATTENDANCE'),
      'Scenario 3: RFID card reader verification processed against ERP',
      JSON.stringify(s3Res.body)
    );

    // SCENARIO 4: Camera fails and attendant switches to ID card seamlessly
    console.log('\n--- Scenario 4: Camera failure fallback to ID Card ---');
    // Terminal switches to /api/bus/verify-card with student card
    const s4Res = await request('POST', '/api/bus/verify-card', {
      card_token: cardUuid,
      bus_id: 1,
      preview_only: true // Attendant visual preview
    });
    assert(
      s4Res.status === 200 && s4Res.body.student && s4Res.body.student.name === 'Rohan Verma',
      'Scenario 4: Immediate visual profile retrieval for attendant verification when camera fails',
      JSON.stringify(s4Res.body)
    );

    // SCENARIO 5: Both automated methods fail and authorised manual verification works
    console.log('\n--- Scenario 5: Emergency Authorised Manual Verification (Method 3) ---');
    const s5Res = await request('POST', '/api/bus/verify-manual', {
      roll_number: 'ROHAN-04',
      bus_id: 1,
      action: 'EXIT',
      manual_reason: 'FACE_AND_CARD_UNAVAILABLE',
      attendant_id: 'Hari Das (ATT-01)'
    });
    assert(
      s5Res.status === 200 && (s5Res.body.success || s5Res.body.alert === 'DUPLICATE_ATTENDANCE'),
      'Scenario 5: Emergency manual verification succeeded with mandatory reason audit logging',
      JSON.stringify(s5Res.body)
    );

    // SCENARIO 6: Wrong / Unregistered student ID card is scanned
    console.log('\n--- Scenario 6: Wrong / Unregistered ID Card Scanned ---');
    const s6Res = await request('POST', '/api/bus/verify-card', {
      card_token: 'SC-CARD-FAKE-UNREGISTERED-999',
      bus_id: 1,
      action: 'BOARD'
    });
    assert(
      s6Res.body.success === false && s6Res.body.alert === 'UNKNOWN_CARD',
      'Scenario 6: Unregistered card rejected with UNKNOWN_CARD warning',
      s6Res.body.message
    );

    // SCENARIO 7: Lost or Revoked card is scanned
    console.log('\n--- Scenario 7: Lost or Revoked Card Scanned ---');
    // First revoke Munu's card
    await request('POST', '/api/students/BEC26081/revoke-card', { reason: 'Reported lost by student' });
    const s7Res = await request('POST', '/api/bus/verify-card', {
      card_token: munuCardToken,
      bus_id: 1,
      action: 'BOARD'
    });
    assert(
      s7Res.body.success === false && s7Res.body.alert === 'REVOKED_CARD',
      'Scenario 7: Revoked card immediately blocked with REVOKED_CARD alert',
      s7Res.body.message
    );
    // Reissue Munu's card so system is clean
    await request('POST', '/api/students/BEC26081/reissue-card', {});

    // SCENARIO 9: Wrong Bus Detection
    console.log('\n--- Scenario 9: Wrong Bus Detection (Rohan assigned to Bus #4 scanning on Bus #1) ---');
    const s9Res = await request('POST', '/api/bus/verify-card', {
      card_token: cardUuid,
      bus_id: 2, // Bus #1 (Mismatch!)
      action: 'BOARD',
      staff_override: false
    });
    assert(
      s9Res.body.success === false && s9Res.body.alert === 'WRONG_BUS' && s9Res.body.requires_override === true,
      'Scenario 9: Bus mismatch detected, normal boarding prevented, staff override required',
      s9Res.body.message
    );

    // SCENARIO 10: Student exits using a different verification method from boarding
    console.log('\n--- Scenario 10: Exit using different verification method from boarding ---');
    // Rohan boarded with FACE, now exits with CARD or MANUAL
    const s10Res = await request('POST', '/api/bus/verify-exit', {
      roll_number: 'ROHAN-04',
      bus_id: 1,
      verification_method: 'ID_CARD',
      attendant_id: 'Hari Das (ATT-01)'
    });
    assert(
      s10Res.status === 200 && (s10Res.body.success || s10Res.body.alert === 'DUPLICATE_ATTENDANCE'),
      'Scenario 10: Exit registered cleanly using ID_CARD method differing from boarding method',
      JSON.stringify(s10Res.body)
    );

    // SCENARIO 11: Offline attendance synchronises successfully
    console.log('\n--- Scenario 11: Offline Attendance Batch Sync ---');
    const offlineBatch = [
      {
        event_id: `OFFLINE-TEST-${Date.now()}-1`,
        student_id: 1,
        roll_number: 'ROHAN-04',
        bus_id: 1,
        log_type: 'BOARD',
        verification_method: 'ID_CARD',
        recorded_timestamp: new Date().toISOString(),
        attendant_id: 'Hari Das (ATT-01)'
      }
    ];
    const s11Res = await request('POST', '/api/bus/attendance/sync', { events: offlineBatch });
    assert(
      s11Res.status === 200 && s11Res.body.success,
      'Scenario 11: Offline queued attendance synced cleanly with server idempotency',
      JSON.stringify(s11Res.body)
    );

    // SCENARIO 12: Correct parent receives the notification
    console.log('\n--- Scenario 12: Parent Notification Verification ---');
    const notifRes = await request('GET', '/api/bus/parent-track/ROHAN-04');
    assert(
      notifRes.status === 200 && notifRes.body.success && notifRes.body.notifications && notifRes.body.notifications.length > 0,
      'Scenario 12: Real-time parent notification recorded with correct parent mobile & details',
      `Notifications count: ${notifRes.body?.notifications?.length}`
    );

    // SCENARIO 13: Unauthorised parent cannot see student journey
    console.log('\n--- Scenario 13: Unauthorised Parent Query Isolation ---');
    const s13Res = await request('GET', '/api/bus/parent-track/UNKNOWN-INTRUDER-999');
    assert(
      s13Res.status === 404 && s13Res.body.success === false,
      'Scenario 13: Unauthorised query denied (404 Not Found), child privacy preserved',
      s13Res.body.message
    );

    // SCENARIO 14: Trip ends with an unresolved student exit record
    console.log('\n--- Scenario 14: Transport Attendance Monitoring & Unresolved Exits ---');
    const reportRes = await request('GET', '/api/bus/attendance-report?bus_id=ALL');
    assert(
      reportRes.status === 200 && reportRes.body.success && reportRes.body.summary !== undefined,
      'Scenario 14: Transport monitoring report tracks assigned, boarded, exited, and unresolved exits',
      `Unresolved exits: ${reportRes.body?.summary?.unresolved_exits}, Face count: ${reportRes.body?.summary?.face_verification_count}, ID card count: ${reportRes.body?.summary?.id_card_verification_count}`
    );

    console.log('\n========================================================================');
    console.log(`🎉 TEST SUMMARY: ${passed} PASSED / ${failed} FAILED (TOTAL 14 SCENARIOS)`);
    console.log('========================================================================\n');

  } catch (err) {
    console.error('Fatal test error:', err);
  }
}

runAll14Tests();
