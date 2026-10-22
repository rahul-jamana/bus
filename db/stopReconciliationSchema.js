/**
 * SafeRide AI — Stop-Level Custody Reconciliation Schema
 * 
 * Tables implemented:
 * 1. students: id, name, class, guardian_id, active
 * 2. routes: id, name, school_id, stops (JSON array of stop ids)
 * 3. stops: id, route_id, name, lat, lng, geofence_radius_m, sequence
 * 4. expected_drops: id, student_id, route_id, stop_id, active_from, active_to
 * 5. trips: id, route_id, bus_id, driver_id, attendant_id, started_at, ended_at, status
 * 6. boarding_events: id, trip_id, student_id, type, method, stop_id, timestamp, device_id, synced, idempotency_key
 * 7. incidents: id, trip_id, student_id, stop_id, type, severity, status, assigned_to, resolution_reason, created_at, resolved_at
 * 8. audit_log: id, actor_id, action, entity, entity_id, reason, timestamp
 * 9. school_attendance: id, student_id, date, status (for absent student handling)
 */

const { dbRun, dbGet, dbQuery } = require('./database');

async function initStopReconciliationDB() {
  try {
    // 1. Ensure students table has class, guardian_id, active
    await dbRun(`
      CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT UNIQUE,
        name TEXT NOT NULL,
        roll_number TEXT,
        class TEXT DEFAULT 'Grade 5',
        guardian_id TEXT DEFAULT 'G-100',
        active INTEGER DEFAULT 1
      )
    `);

    // Add columns to students if missing
    try {
      const studentCols = await dbQuery("PRAGMA table_info(students)");
      const colNames = studentCols.map(c => c.name);
      if (!colNames.includes('class')) await dbRun("ALTER TABLE students ADD COLUMN class TEXT DEFAULT 'Grade 5'");
      if (!colNames.includes('guardian_id')) await dbRun("ALTER TABLE students ADD COLUMN guardian_id TEXT DEFAULT 'G-100'");
      if (!colNames.includes('active')) await dbRun("ALTER TABLE students ADD COLUMN active INTEGER DEFAULT 1");
    } catch (e) {}

    // 2. routes: id, name, school_id, stops
    await dbRun(`
      CREATE TABLE IF NOT EXISTS routes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        school_id TEXT DEFAULT 'SCH-01',
        stops TEXT, -- JSON array of stop IDs
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 3. stops: id, route_id, name, lat, lng, geofence_radius_m, sequence
    await dbRun(`
      CREATE TABLE IF NOT EXISTS stops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        geofence_radius_m INTEGER DEFAULT 500,
        sequence INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 4. expected_drops: id, student_id, route_id, stop_id, active_from, active_to
    await dbRun(`
      CREATE TABLE IF NOT EXISTS expected_drops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        route_id INTEGER NOT NULL,
        stop_id INTEGER NOT NULL,
        active_from DATE DEFAULT (date('now')),
        active_to DATE DEFAULT '2099-12-31',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 5. trips: id, route_id, bus_id, driver_id, attendant_id, started_at, ended_at, status
    await dbRun(`
      CREATE TABLE IF NOT EXISTS trips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id INTEGER DEFAULT 1,
        bus_id INTEGER DEFAULT 1,
        driver_id TEXT DEFAULT 'DRV-01',
        attendant_id TEXT DEFAULT 'ATT-01',
        started_at DATETIME,
        ended_at DATETIME,
        status TEXT DEFAULT 'SCHEDULED' -- SCHEDULED, ACTIVE, COMPLETED, CANCELLED
      )
    `);

    // Add attendant_id, driver_id, route_id, current_stop_id to trips if missing
    try {
      const tripCols = await dbQuery("PRAGMA table_info(trips)");
      const tripColNames = tripCols.map(c => c.name);
      if (!tripColNames.includes('route_id')) await dbRun("ALTER TABLE trips ADD COLUMN route_id INTEGER DEFAULT 1");
      if (!tripColNames.includes('driver_id')) await dbRun("ALTER TABLE trips ADD COLUMN driver_id TEXT DEFAULT 'DRV-01'");
      if (!tripColNames.includes('attendant_id')) await dbRun("ALTER TABLE trips ADD COLUMN attendant_id TEXT DEFAULT 'ATT-01'");
      if (!tripColNames.includes('current_stop_id')) await dbRun("ALTER TABLE trips ADD COLUMN current_stop_id INTEGER DEFAULT 0");
    } catch (e) {}

    // 6. boarding_events: id, trip_id, student_id, type(BOARD/EXIT), method(QR/FACE/MANUAL), stop_id, timestamp, device_id, synced, idempotency_key
    await dbRun(`
      CREATE TABLE IF NOT EXISTS boarding_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        type TEXT NOT NULL, -- BOARD, EXIT
        method TEXT NOT NULL, -- QR, FACE, MANUAL
        stop_id INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        device_id TEXT DEFAULT 'DEV-BUS-01',
        synced INTEGER DEFAULT 1,
        idempotency_key TEXT UNIQUE,
        reason TEXT -- mandatory when method is MANUAL
      )
    `);

    // 7. incidents: id, trip_id, student_id, stop_id, type, severity, status(OPEN/ASSIGNED/RESOLVED/OVERRIDE), assigned_to, resolution_reason, created_at, resolved_at
    await dbRun(`
      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER NOT NULL,
        student_id INTEGER,
        stop_id INTEGER,
        type TEXT NOT NULL, -- MISSING_DROP_OFF, UNMONITORED_EXIT, OFFLINE_CONFLICT, ROUTE_CHANGE_SKIP
        severity TEXT DEFAULT 'MEDIUM', -- LOW, MEDIUM, HIGH, CRITICAL
        status TEXT DEFAULT 'OPEN', -- OPEN, ASSIGNED, RESOLVED, OVERRIDE
        assigned_to TEXT,
        resolution_reason TEXT,
        resolved_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME
      )
    `);

    // 8. audit_log: id, actor_id, action, entity, entity_id, reason, timestamp
    await dbRun(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL, -- TRIP_START, GEOFENCE_ENTER, GEOFENCE_EXIT, INCIDENT_CREATE, INCIDENT_RESOLVE, OVERRIDE, PLAN_CHANGE
        entity TEXT NOT NULL, -- TRIP, STOP, STUDENT, INCIDENT
        entity_id TEXT NOT NULL,
        reason TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 9. school_attendance: student_id, date, status (PRESENT / ABSENT)
    await dbRun(`
      CREATE TABLE IF NOT EXISTS school_attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        date DATE DEFAULT (date('now')),
        status TEXT DEFAULT 'PRESENT', -- PRESENT, ABSENT
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Synchronize Real Master Routes, Stops, and Student Expected Drops (No Mock Test Data)
    await syncRealData();

    console.log('✅ SafeRide AI Stop-Level Custody Reconciliation Schema Initialized (Production Mode — Real Data Active)');
  } catch (err) {
    console.error('Error initializing Stop Reconciliation DB:', err);
  }
}

async function syncRealData() {
  // 1. Ensure at least one route exists from bus_routes if routes table is empty
  const routeCount = await dbGet('SELECT COUNT(*) as c FROM routes');
  let routeId = 1;
  if (!routeCount || routeCount.c === 0) {
    const rRes = await dbRun(`
      INSERT INTO routes (name, school_id, stops)
      VALUES ('Khordha Corridor (Bus #1)', 'SCH-01', '[]')
    `);
    routeId = rRes.id;
  } else {
    const r = await dbGet('SELECT id FROM routes LIMIT 1');
    routeId = r.id;
  }

  // 2. Ensure real stops from bus_stops exist in stops
  const stopCount = await dbGet('SELECT COUNT(*) as c FROM stops WHERE route_id = ?', [routeId]);
  if (!stopCount || stopCount.c === 0) {
    const realBusStops = await dbQuery('SELECT * FROM bus_stops ORDER BY stop_sequence ASC');
    const stopIds = [];
    for (const s of realBusStops) {
      const ins = await dbRun(
        'INSERT INTO stops (route_id, name, lat, lng, geofence_radius_m, sequence) VALUES (?, ?, ?, ?, ?, ?)',
        [routeId, s.stop_name, s.gps_lat, s.gps_lng, s.geofence_radius_meters || 500, s.stop_sequence]
      );
      stopIds.push(ins.id);
    }
    await dbRun('UPDATE routes SET stops = ? WHERE id = ?', [JSON.stringify(stopIds), routeId]);
  }

  // 3. Map real students with drop_stop_name to stops in expected_drops if not already mapped
  const unmappedStudents = await dbQuery(`
    SELECT s.id, s.drop_stop_name 
    FROM students s
    WHERE s.active = 1 AND s.drop_stop_name IS NOT NULL
      AND s.id NOT IN (SELECT student_id FROM expected_drops)
  `);

  for (const stu of unmappedStudents) {
    const matchStop = await dbGet('SELECT id FROM stops WHERE name = ?', [stu.drop_stop_name]);
    if (matchStop) {
      await dbRun(
        'INSERT INTO expected_drops (student_id, route_id, stop_id) VALUES (?, ?, ?)',
        [stu.id, routeId, matchStop.id]
      );
    }
  }
}

module.exports = {
  initStopReconciliationDB
};
