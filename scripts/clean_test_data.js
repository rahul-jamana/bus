const { dbRun, dbGet, dbQuery } = require('../db/database');

async function cleanAndSyncRealData() {
  console.log('🧹 [SafeRide AI] Cleaning all test data from database...');

  // 1. Delete mock test students
  const delStu = await dbRun(
    `DELETE FROM students WHERE id IN (101, 102, 103, 104) OR student_id IN ('STU-AARAV', 'STU-DIYA', 'STU-ROHAN-103', 'STU-TANYA')`
  );
  console.log(`✅ Removed test students: ${delStu.changes} rows deleted.`);

  // 2. Delete test trip 501
  const delTrips = await dbRun(`DELETE FROM trips WHERE id = 501`);
  console.log(`✅ Removed test trip 501: ${delTrips.changes} rows deleted.`);

  // 3. Clear mock test boarding events
  const delEvents = await dbRun(
    `DELETE FROM boarding_events WHERE trip_id = 501 OR student_id IN (101, 102, 103, 104)`
  );
  console.log(`✅ Removed test boarding events: ${delEvents.changes} rows deleted.`);

  // 4. Clear mock test incidents
  const delIncs = await dbRun(
    `DELETE FROM incidents WHERE trip_id = 501 OR student_id IN (101, 102, 103, 104)`
  );
  console.log(`✅ Removed test incidents: ${delIncs.changes} rows deleted.`);

  // 5. Clear mock test audit entries
  const delAudit = await dbRun(
    `DELETE FROM audit_log WHERE entity_id = '501' OR entity_id IN ('101', '102', '103', '104')`
  );
  console.log(`✅ Removed test audit trail entries: ${delAudit.changes} rows deleted.`);

  // 6. Clear mock school attendance entries
  const delAtt = await dbRun(
    `DELETE FROM school_attendance WHERE student_id IN (101, 102, 103, 104)`
  );
  console.log(`✅ Removed test school attendance entries: ${delAtt.changes} rows deleted.`);

  // 7. Clear mock expected drops
  const delDrops = await dbRun(
    `DELETE FROM expected_drops WHERE student_id IN (101, 102, 103, 104)`
  );
  console.log(`✅ Removed test expected drops: ${delDrops.changes} rows deleted.`);

  // 8. Delete mock Greenwood Campus route and mock stops
  await dbRun(`DELETE FROM stops WHERE route_id = 1 AND name LIKE 'Stop % — %'`);
  await dbRun(`DELETE FROM routes WHERE name = 'Greenwood Campus Route A'`);
  console.log('✅ Removed mock Greenwood Campus route and demo stops.');

  // 9. Sync Real Routes & Real Stops from bus_routes & bus_stops
  let realRoute = await dbGet(`SELECT * FROM routes WHERE name = 'Khordha Corridor (Bus #1)'`);
  let routeId;
  if (!realRoute) {
    const rRes = await dbRun(
      `INSERT INTO routes (name, school_id, stops) VALUES ('Khordha Corridor (Bus #1)', 'SCH-01', '[]')`
    );
    routeId = rRes.id;
  } else {
    routeId = realRoute.id;
  }

  // Populate stops from real bus_stops
  const realStops = await dbQuery(`SELECT * FROM bus_stops ORDER BY stop_sequence ASC`);
  const stopIds = [];
  for (const s of realStops) {
    let existingStop = await dbGet(`SELECT * FROM stops WHERE route_id = ? AND name = ?`, [routeId, s.stop_name]);
    if (!existingStop) {
      const insStop = await dbRun(
        `INSERT INTO stops (route_id, name, lat, lng, geofence_radius_m, sequence) VALUES (?, ?, ?, ?, ?, ?)`,
        [routeId, s.stop_name, s.gps_lat, s.gps_lng, s.geofence_radius_meters || 500, s.stop_sequence]
      );
      stopIds.push(insStop.id);
    } else {
      stopIds.push(existingStop.id);
    }
  }

  // Master Canteen stop
  let mcStop = await dbGet(`SELECT * FROM stops WHERE name = 'Master Canteen'`);
  if (!mcStop) {
    const insMC = await dbRun(
      `INSERT INTO stops (route_id, name, lat, lng, geofence_radius_m, sequence) VALUES (?, 'Master Canteen', 20.2640, 85.8390, 500, 10)`,
      [routeId]
    );
    stopIds.push(insMC.id);
  } else {
    stopIds.push(mcStop.id);
  }

  await dbRun(`UPDATE routes SET stops = ? WHERE id = ?`, [JSON.stringify(stopIds), routeId]);
  console.log(`✅ Synchronized ${stopIds.length} real stops for Route ${routeId} ("Khordha Corridor").`);

  // 10. Map real students to real stops in expected_drops
  const realStudents = await dbQuery(`SELECT id, student_id, name, drop_stop_name FROM students WHERE active = 1`);
  let mappedCount = 0;
  for (const stu of realStudents) {
    if (!stu.drop_stop_name) continue;
    const matchStop = await dbGet(`SELECT id FROM stops WHERE name = ?`, [stu.drop_stop_name]);
    if (matchStop) {
      const exists = await dbGet(
        `SELECT id FROM expected_drops WHERE student_id = ? AND stop_id = ?`,
        [stu.id, matchStop.id]
      );
      if (!exists) {
        await dbRun(
          `INSERT INTO expected_drops (student_id, route_id, stop_id) VALUES (?, ?, ?)`,
          [stu.id, routeId, matchStop.id]
        );
        mappedCount++;
      }
    }
  }
  console.log(`✅ Successfully mapped ${mappedCount} real students to their drop stops in expected_drops.`);

  // 11. Connect real active trip 102 with routeId
  await dbRun(`UPDATE trips SET route_id = ? WHERE id = 102`, [routeId]);
  console.log(`✅ Set real active Trip 102 to Route ${routeId}.`);

  console.log('\n🎉 ALL TEST DATA REMOVED. Database is 100% synchronized with REAL data!');
}

cleanAndSyncRealData()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Error during cleanup:', err);
    process.exit(1);
  });
