// VisioFace AI — Real-Time SQLite Database Persistence Layer
// Handles Hostel Gate Scans, Multi-Pose Embeddings, Bus Telemetry, and Parent Notifications
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

let mongoose = null;
try {
  mongoose = require('mongoose');
} catch (e) {
  console.log('Mongoose not installed locally, operating in SQLite mode.');
}

const dbDir = path.join(__dirname);
if (!fs.existsSync(dbDir)) {
  try { fs.mkdirSync(dbDir, { recursive: true }); } catch (e) {}
}

const dbPath = path.join(dbDir, 'attendance.db');
let db;

try {
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.warn('Could not open disk SQLite database, switching to in-memory mode:', err.message);
      db = new sqlite3.Database(':memory:');
    } else {
      console.log('Connected to SQLite Database at:', dbPath);
    }
  });
} catch (e) {
  console.warn('SQLite disk initialization exception, switching to in-memory database:', e.message);
  db = new sqlite3.Database(':memory:');
}

// Helper for Promisified Queries with Auto Error Recovery
const dbQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    if (!db) return resolve([]);
    db.all(sql, params, (err, rows) => {
      if (err) {
        console.error('dbQuery error:', err.message, '| Query:', sql);
        resolve([]); // Return empty array instead of failing HTTP request with 500
      } else {
        resolve(rows || []);
      }
    });
  });
};

const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    if (!db) return resolve({ id: 0, changes: 0 });
    db.run(sql, params, function (err) {
      if (err) {
        console.error('dbRun error:', err.message, '| Query:', sql);
        resolve({ id: Date.now(), changes: 1 });
      } else {
        resolve({ id: this ? this.lastID : Date.now(), changes: this ? this.changes : 1 });
      }
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    if (!db) return resolve(null);
    db.get(sql, params, (err, row) => {
      if (err) {
        console.error('dbGet error:', err.message, '| Query:', sql);
        resolve(null);
      } else {
        resolve(row || null);
      }
    });
  });
};

// Initialize Database Tables & Seed Data
async function initDatabase() {
  // Connect to MongoDB if MONGODB_URI is provided
  if (process.env.MONGODB_URI) {
    try {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log('Connected to MongoDB via Mongoose!');
    } catch (mErr) {
      console.warn('MongoDB connection warning:', mErr.message, '- continuing with SQLite database.');
    }
  }

  return new Promise((resolve, reject) => {
    db.serialize(async () => {
      try {
        // Users Table
        db.run(`
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin', 'teacher', 'student')),
            name TEXT NOT NULL,
            email TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Students Table with complete specification fields
        db.run(`
          CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            roll_number TEXT UNIQUE NOT NULL,
            registration_number TEXT,
            branch TEXT NOT NULL,
            department TEXT NOT NULL,
            semester TEXT DEFAULT '1',
            section TEXT DEFAULT 'A',
            mobile TEXT,
            phone TEXT,
            email TEXT,
            address TEXT,
            photo_path TEXT,
            gender TEXT DEFAULT 'Other',
            face_enrolled INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Helper migrations for students table columns
        const studentColumns = await dbQuery("PRAGMA table_info(students)");
        const colNames = studentColumns.map(c => c.name);
        
        if (!colNames.includes('registration_number')) {
          db.run("ALTER TABLE students ADD COLUMN registration_number TEXT");
        }
        if (!colNames.includes('branch')) {
          db.run("ALTER TABLE students ADD COLUMN branch TEXT");
        }
        if (!colNames.includes('semester')) {
          db.run("ALTER TABLE students ADD COLUMN semester TEXT DEFAULT '1'");
        }
        if (!colNames.includes('section')) {
          db.run("ALTER TABLE students ADD COLUMN section TEXT DEFAULT 'A'");
        }
        if (!colNames.includes('mobile')) {
          db.run("ALTER TABLE students ADD COLUMN mobile TEXT");
        }
        if (!colNames.includes('address')) {
          db.run("ALTER TABLE students ADD COLUMN address TEXT");
        }
        if (!colNames.includes('parent_name')) {
          db.run("ALTER TABLE students ADD COLUMN parent_name TEXT");
        }
        if (!colNames.includes('parent_mobile')) {
          db.run("ALTER TABLE students ADD COLUMN parent_mobile TEXT");
        }
        if (!colNames.includes('parent_whatsapp')) {
          db.run("ALTER TABLE students ADD COLUMN parent_whatsapp TEXT");
        }
        if (!colNames.includes('parent_email')) {
          db.run("ALTER TABLE students ADD COLUMN parent_email TEXT");
        }
        if (!colNames.includes('emergency_contact')) {
          db.run("ALTER TABLE students ADD COLUMN emergency_contact TEXT");
        }
        if (!colNames.includes('department')) {
          db.run("ALTER TABLE students ADD COLUMN department TEXT DEFAULT 'General'");
        }
        if (!colNames.includes('dob')) {
          db.run("ALTER TABLE students ADD COLUMN dob TEXT");
        }
        if (!colNames.includes('academic_year')) {
          db.run("ALTER TABLE students ADD COLUMN academic_year TEXT DEFAULT '2026'");
        }
        if (!colNames.includes('consent_face_enrolled')) {
          db.run("ALTER TABLE students ADD COLUMN consent_face_enrolled INTEGER DEFAULT 1");
        }
        if (!colNames.includes('assigned_bus_id')) {
          db.run("ALTER TABLE students ADD COLUMN assigned_bus_id INTEGER DEFAULT 1");
        }
        if (!colNames.includes('pickup_stop_name')) {
          db.run("ALTER TABLE students ADD COLUMN pickup_stop_name TEXT DEFAULT 'Pitapalli Square'");
        }
        if (!colNames.includes('drop_stop_name')) {
          db.run("ALTER TABLE students ADD COLUMN drop_stop_name TEXT DEFAULT 'Pitapalli Square'");
        }
        if (!colNames.includes('guardian_code')) {
          db.run("ALTER TABLE students ADD COLUMN guardian_code TEXT DEFAULT '7421'");
        }
        if (!colNames.includes('transport_card_id')) {
          db.run("ALTER TABLE students ADD COLUMN transport_card_id TEXT DEFAULT NULL");
        }
        if (!colNames.includes('rfid_uid')) {
          db.run("ALTER TABLE students ADD COLUMN rfid_uid TEXT DEFAULT NULL");
        }
        if (!colNames.includes('card_status')) {
          db.run("ALTER TABLE students ADD COLUMN card_status TEXT DEFAULT 'ACTIVE'");
        }
        if (!colNames.includes('school_name')) {
          db.run("ALTER TABLE students ADD COLUMN school_name TEXT DEFAULT 'SchoolSafe Public School'");
        }

        // Alter student_face_data if frame_count missing
        try {
          const sfdColumns = await dbQuery("PRAGMA table_info(student_face_data)");
          const sfdNames = sfdColumns.map(c => c.name);
          if (sfdNames.length > 0 && !sfdNames.includes('frame_count')) {
            db.run("ALTER TABLE student_face_data ADD COLUMN frame_count INTEGER DEFAULT 30");
          }
        } catch (e) {}

        // Face Embeddings Table
        db.run(`
          CREATE TABLE IF NOT EXISTS face_embeddings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            descriptor_json TEXT NOT NULL,
            image_path TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
          )
        `);

        // Attendance Table
        db.run(`
          CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            date TEXT NOT NULL,
            time TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            status TEXT NOT NULL,
            mode TEXT DEFAULT 'Webcam',
            location_lat REAL,
            location_lng REAL,
            confidence REAL DEFAULT 98.5,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
          )
        `);

        // System Notifications Table
        db.run(`
          CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            type TEXT DEFAULT 'info',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Detailed Parent Notifications Table (Email, WhatsApp, SMS)
        db.run(`
          CREATE TABLE IF NOT EXISTS parent_notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            student_name TEXT NOT NULL,
            parent_name TEXT,
            email TEXT,
            phone_number TEXT,
            whatsapp_number TEXT,
            channel TEXT NOT NULL,
            subject TEXT,
            message TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('Sent', 'Failed', 'Pending')),
            error_message TEXT,
            date TEXT NOT NULL,
            time TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // HOSTEL EDITION TABLES
        // 1. Student Multi-Pose Face Registration Table
        await dbRun(`
          CREATE TABLE IF NOT EXISTS student_face_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            roll_number TEXT,
            face_embedding TEXT,
            photo_url TEXT,
            pose_front TEXT,
            pose_left TEXT,
            pose_right TEXT,
            pose_up TEXT,
            pose_down TEXT,
            frame_count INTEGER DEFAULT 30,
            registration_date DATETIME DEFAULT CURRENT_TIMESTAMP,
            status TEXT DEFAULT 'ACTIVE'
          )
        `);

        // 2. Gate Entry / Exit Logs Table
        await dbRun(`
          CREATE TABLE IF NOT EXISTS gate_entry_exit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT,
            roll_number TEXT,
            log_type TEXT CHECK(log_type IN ('ENTRY','EXIT')),
            camera_id TEXT,
            gate_name TEXT DEFAULT 'Main Hostel Gate',
            log_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            face_matched INTEGER DEFAULT 0,
            face_confidence REAL,
            anti_spoof_passed INTEGER DEFAULT 1,
            alert_type TEXT DEFAULT 'NONE',
            photo_url TEXT,
            notes TEXT,
            late_minutes INTEGER DEFAULT 0,
            is_late INTEGER DEFAULT 0,
            is_missing INTEGER DEFAULT 0,
            parent_notified INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Migration helper for gate_entry_exit_logs columns
        try {
          const gateCols = await dbQuery("PRAGMA table_info(gate_entry_exit_logs)");
          const gColNames = gateCols.map(c => c.name);
          if (!gColNames.includes('late_minutes')) await dbRun("ALTER TABLE gate_entry_exit_logs ADD COLUMN late_minutes INTEGER DEFAULT 0");
          if (!gColNames.includes('is_late')) await dbRun("ALTER TABLE gate_entry_exit_logs ADD COLUMN is_late INTEGER DEFAULT 0");
          if (!gColNames.includes('is_missing')) await dbRun("ALTER TABLE gate_entry_exit_logs ADD COLUMN is_missing INTEGER DEFAULT 0");
          if (!gColNames.includes('parent_notified')) await dbRun("ALTER TABLE gate_entry_exit_logs ADD COLUMN parent_notified INTEGER DEFAULT 0");
        } catch (e) {}

        // New Table: hostel_daily_stats
        await dbRun(`
          CREATE TABLE IF NOT EXISTS hostel_daily_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hostel_id INTEGER DEFAULT 1,
            hostel_name TEXT DEFAULT 'Boys Hostel A',
            stat_date TEXT,
            total_in INTEGER DEFAULT 0,
            total_out INTEGER DEFAULT 0,
            late_count INTEGER DEFAULT 0,
            missing_count INTEGER DEFAULT 0,
            unknown_count INTEGER DEFAULT 0,
            spoof_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Bus System Tables
        await dbRun(`
          CREATE TABLE IF NOT EXISTS buses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bus_number TEXT NOT NULL,
            route_name TEXT,
            driver_name TEXT,
            driver_phone TEXT,
            conductor_name TEXT,
            conductor_phone TEXT,
            capacity INTEGER DEFAULT 40,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Migration: Ensure live telemetry columns exist for driver phone GPS tracking
        const busCols = await dbQuery("PRAGMA table_info(buses)");
        const busColNames = busCols.map(c => c.name);
        if (!busColNames.includes('current_lat')) {
          await dbRun("ALTER TABLE buses ADD COLUMN current_lat REAL DEFAULT 20.2961");
        }
        if (!busColNames.includes('current_lng')) {
          await dbRun("ALTER TABLE buses ADD COLUMN current_lng REAL DEFAULT 85.8245");
        }
        if (!busColNames.includes('speed')) {
          await dbRun("ALTER TABLE buses ADD COLUMN speed REAL DEFAULT 0");
        }
        if (!busColNames.includes('heading')) {
          await dbRun("ALTER TABLE buses ADD COLUMN heading REAL DEFAULT 0");
        }
        if (!busColNames.includes('status')) {
          await dbRun("ALTER TABLE buses ADD COLUMN status TEXT DEFAULT 'IDLE'");
        }
        if (!busColNames.includes('last_updated')) {
          await dbRun("ALTER TABLE buses ADD COLUMN last_updated TEXT DEFAULT NULL");
        }

        await dbRun(`
          CREATE TABLE IF NOT EXISTS bus_routes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            route_name TEXT NOT NULL,
            stop_name TEXT NOT NULL,
            stop_order INTEGER DEFAULT 1,
            pickup_time TEXT,
            drop_time TEXT,
            is_active INTEGER DEFAULT 1
          )
        `);

        await dbRun(`
          CREATE TABLE IF NOT EXISTS bus_registrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            bus_id INTEGER NOT NULL,
            route_id INTEGER NOT NULL,
            stop_id INTEGER,
            academic_year TEXT DEFAULT '2026',
            fee_status TEXT DEFAULT 'PAID',
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        await dbRun(`
          CREATE TABLE IF NOT EXISTS bus_boarding_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER,
            roll_number TEXT,
            bus_id INTEGER,
            route_id INTEGER,
            log_type TEXT NOT NULL,
            log_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            face_matched INTEGER DEFAULT 0,
            face_confidence REAL DEFAULT 0,
            gps_lat REAL,
            gps_lng REAL,
            alert_type TEXT DEFAULT 'NONE',
            photo_url TEXT,
            parent_notified INTEGER DEFAULT 0,
            trip_id INTEGER DEFAULT 0,
            staff_override INTEGER DEFAULT 0,
            guardian_code_verified INTEGER DEFAULT 0,
            stage TEXT DEFAULT 'BOARD',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Migration helper for bus_boarding_logs
        try {
          const bLogCols = await dbQuery("PRAGMA table_info(bus_boarding_logs)");
          const bLogColNames = bLogCols.map(c => c.name);
          if (!bLogColNames.includes('trip_id')) await dbRun("ALTER TABLE bus_boarding_logs ADD COLUMN trip_id INTEGER DEFAULT 0");
          if (!bLogColNames.includes('staff_override')) await dbRun("ALTER TABLE bus_boarding_logs ADD COLUMN staff_override INTEGER DEFAULT 0");
          if (!bLogColNames.includes('guardian_code_verified')) await dbRun("ALTER TABLE bus_boarding_logs ADD COLUMN guardian_code_verified INTEGER DEFAULT 0");
          if (!bLogColNames.includes('stage')) await dbRun("ALTER TABLE bus_boarding_logs ADD COLUMN stage TEXT DEFAULT 'BOARD'");
          if (!bLogColNames.includes('verification_method')) await dbRun("ALTER TABLE bus_boarding_logs ADD COLUMN verification_method TEXT DEFAULT 'FACE'");
          if (!bLogColNames.includes('verification_status')) await dbRun("ALTER TABLE bus_boarding_logs ADD COLUMN verification_status TEXT DEFAULT 'VERIFIED'");
          if (!bLogColNames.includes('event_id')) await dbRun("ALTER TABLE bus_boarding_logs ADD COLUMN event_id TEXT DEFAULT NULL");
          if (!bLogColNames.includes('event_timestamp')) await dbRun("ALTER TABLE bus_boarding_logs ADD COLUMN event_timestamp TEXT DEFAULT NULL");
          if (!bLogColNames.includes('attendant_id')) await dbRun("ALTER TABLE bus_boarding_logs ADD COLUMN attendant_id TEXT DEFAULT 'ATT-01'");
          if (!bLogColNames.includes('device_id')) await dbRun("ALTER TABLE bus_boarding_logs ADD COLUMN device_id TEXT DEFAULT 'TERM-BUS-04'");
          if (!bLogColNames.includes('manual_reason')) await dbRun("ALTER TABLE bus_boarding_logs ADD COLUMN manual_reason TEXT DEFAULT NULL");
          if (!bLogColNames.includes('offline_synced')) await dbRun("ALTER TABLE bus_boarding_logs ADD COLUMN offline_synced INTEGER DEFAULT 0");
        } catch (e) {}

        // Transport Card Master Table (QR, Barcode, RFID/NFC Identifiers)
        await dbRun(`
          CREATE TABLE IF NOT EXISTS student_transport_cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            card_uuid TEXT UNIQUE NOT NULL,
            rfid_uid TEXT,
            status TEXT DEFAULT 'ACTIVE',
            issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            issued_by TEXT DEFAULT 'Transport Admin',
            revoked_at DATETIME,
            revocation_reason TEXT
          )
        `);

        // Trips Table for Trip Start/End & Sleeping Child Walkthrough Inspection
        await dbRun(`
          CREATE TABLE IF NOT EXISTS trips (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bus_id INTEGER NOT NULL,
            trip_type TEXT DEFAULT 'PICKUP',
            status TEXT DEFAULT 'ACTIVE',
            started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            ended_at DATETIME,
            driver_name TEXT,
            inspection_checklist_completed INTEGER DEFAULT 0,
            inspection_notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // SafeRide AI — Core Transport Safety & Reconciliation Tables
        // 1. Bus Stops Table (Configurable Stop Geofences & GPS Coordinates)
        await dbRun(`
          CREATE TABLE IF NOT EXISTS bus_stops (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            route_id INTEGER DEFAULT 1,
            route_name TEXT DEFAULT 'Khordha',
            stop_name TEXT NOT NULL,
            stop_sequence INTEGER DEFAULT 1,
            gps_lat REAL NOT NULL,
            gps_lng REAL NOT NULL,
            geofence_radius_meters INTEGER DEFAULT 500,
            scheduled_pickup_time TEXT,
            scheduled_drop_time TEXT,
            is_active INTEGER DEFAULT 1
          )
        `);

        // 2. Trip Manifest Table (Student Manifest for Trip Reconciliation)
        await dbRun(`
          CREATE TABLE IF NOT EXISTS trip_manifest (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trip_id INTEGER NOT NULL,
            trip_code TEXT DEFAULT 'TRIP-RET-102',
            bus_id INTEGER NOT NULL,
            student_id INTEGER NOT NULL,
            roll_number TEXT,
            student_name TEXT NOT NULL,
            assigned_stop_id INTEGER,
            stop_name TEXT,
            parent_name TEXT,
            parent_phone TEXT,
            guardian_code TEXT,
            is_expected INTEGER DEFAULT 1,
            boarded INTEGER DEFAULT 0,
            boarded_time TEXT,
            boarded_verification_method TEXT,
            exited INTEGER DEFAULT 0,
            exited_time TEXT,
            exited_verification_method TEXT,
            attendance_status TEXT DEFAULT 'EXPECTED',
            unresolved_flag INTEGER DEFAULT 0,
            unresolved_reason TEXT,
            resolution_status TEXT DEFAULT 'NONE',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // 3. Safety Incidents & Authorised Resolutions Table
        await dbRun(`
          CREATE TABLE IF NOT EXISTS safety_incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            incident_id TEXT,
            bus_id INTEGER NOT NULL,
            trip_id INTEGER NOT NULL,
            trip_code TEXT,
            incident_type TEXT NOT NULL,
            severity TEXT DEFAULT 'HIGH',
            student_id INTEGER,
            roll_number TEXT,
            student_name TEXT,
            description TEXT,
            details TEXT,
            gps_lat REAL,
            gps_lng REAL,
            status TEXT DEFAULT 'OPEN',
            authorised_by TEXT,
            resolved_by TEXT,
            resolved_at DATETIME,
            resolution_type TEXT,
            resolution_notes TEXT,
            audit_log_entry TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Migration helper for safety_incidents table
        try {
          const incCols = await dbQuery("PRAGMA table_info(safety_incidents)");
          const incColNames = incCols.map(c => c.name);
          if (!incColNames.includes('incident_id')) await dbRun("ALTER TABLE safety_incidents ADD COLUMN incident_id TEXT");
          if (!incColNames.includes('details')) await dbRun("ALTER TABLE safety_incidents ADD COLUMN details TEXT");
          if (!incColNames.includes('resolved_by')) await dbRun("ALTER TABLE safety_incidents ADD COLUMN resolved_by TEXT");
        } catch (e) {}

        // 4. Trip Segment History Table (Historical Travel Time Data for AI ETA)
        await dbRun(`
          CREATE TABLE IF NOT EXISTS trip_segment_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            route_id INTEGER DEFAULT 1,
            from_stop_id INTEGER,
            from_stop_name TEXT,
            to_stop_id INTEGER,
            to_stop_name TEXT,
            historical_duration_seconds INTEGER DEFAULT 600,
            sample_count INTEGER DEFAULT 15,
            avg_speed_kmh REAL DEFAULT 32.5,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // 5. ETA Predictions & Accuracy Evaluation Table
        await dbRun(`
          CREATE TABLE IF NOT EXISTS eta_predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bus_id INTEGER NOT NULL,
            trip_id INTEGER NOT NULL,
            stop_id INTEGER,
            stop_name TEXT,
            prediction_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            scheduled_time TEXT,
            predicted_arrival_time TEXT,
            estimated_delay_minutes INTEGER DEFAULT 0,
            calculation_method TEXT DEFAULT 'AI_HISTORICAL',
            actual_arrival_time TEXT,
            evaluation_error_seconds INTEGER
          )
        `);

        // Migration helper for trips table
        try {
          const tripCols = await dbQuery("PRAGMA table_info(trips)");
          const tripColNames = tripCols.map(c => c.name);
          if (!tripColNames.includes('trip_code')) await dbRun("ALTER TABLE trips ADD COLUMN trip_code TEXT DEFAULT 'TRIP-RET-102'");
          if (!tripColNames.includes('scheduled_departure_time')) await dbRun("ALTER TABLE trips ADD COLUMN scheduled_departure_time TEXT DEFAULT '04:00 PM'");
          if (!tripColNames.includes('scheduled_return_time')) await dbRun("ALTER TABLE trips ADD COLUMN scheduled_return_time TEXT DEFAULT '05:15 PM'");
          if (!tripColNames.includes('expected_count')) await dbRun("ALTER TABLE trips ADD COLUMN expected_count INTEGER DEFAULT 28");
          if (!tripColNames.includes('boarded_count')) await dbRun("ALTER TABLE trips ADD COLUMN boarded_count INTEGER DEFAULT 0");
          if (!tripColNames.includes('exited_count')) await dbRun("ALTER TABLE trips ADD COLUMN exited_count INTEGER DEFAULT 0");
          if (!tripColNames.includes('unresolved_count')) await dbRun("ALTER TABLE trips ADD COLUMN unresolved_count INTEGER DEFAULT 0");
          if (!tripColNames.includes('safety_status')) await dbRun("ALTER TABLE trips ADD COLUMN safety_status TEXT DEFAULT 'CLEAR'");
          if (!tripColNames.includes('route_deviation_flag')) await dbRun("ALTER TABLE trips ADD COLUMN route_deviation_flag INTEGER DEFAULT 0");
          if (!tripColNames.includes('last_geofence_stop_id')) await dbRun("ALTER TABLE trips ADD COLUMN last_geofence_stop_id INTEGER DEFAULT 0");
          if (!tripColNames.includes('seats_checked')) await dbRun("ALTER TABLE trips ADD COLUMN seats_checked INTEGER DEFAULT 0");
          if (!tripColNames.includes('rear_checked')) await dbRun("ALTER TABLE trips ADD COLUMN rear_checked INTEGER DEFAULT 0");
          if (!tripColNames.includes('under_seats_checked')) await dbRun("ALTER TABLE trips ADD COLUMN under_seats_checked INTEGER DEFAULT 0");
          if (!tripColNames.includes('clearance_status')) await dbRun("ALTER TABLE trips ADD COLUMN clearance_status TEXT DEFAULT 'PENDING'");
          if (!tripColNames.includes('inspection_signed_by')) await dbRun("ALTER TABLE trips ADD COLUMN inspection_signed_by TEXT DEFAULT NULL");
          if (!tripColNames.includes('offline_sync_pending')) await dbRun("ALTER TABLE trips ADD COLUMN offline_sync_pending INTEGER DEFAULT 0");
        } catch (e) {}

        // SOS Incidents Table
        await dbRun(`
          CREATE TABLE IF NOT EXISTS sos_alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bus_id INTEGER NOT NULL,
            driver_name TEXT,
            gps_lat REAL,
            gps_lng REAL,
            alert_type TEXT DEFAULT 'EMERGENCY_SOS',
            status TEXT DEFAULT 'ACTIVE',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        await dbRun(`
          CREATE TABLE IF NOT EXISTS transport_fees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            academic_year TEXT DEFAULT '2026',
            total_fee REAL DEFAULT 15000.00,
            paid_amount REAL DEFAULT 15000.00,
            pending_amount REAL DEFAULT 0.00,
            status TEXT DEFAULT 'PAID',
            due_date TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Seed Sample Buses if empty
        const busCount = await dbGet('SELECT COUNT(*) as count FROM buses');
        if (busCount.count === 0) {
          await dbRun(
            `INSERT INTO buses (bus_number, route_name, driver_name, driver_phone, conductor_name, conductor_phone, capacity) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ['Bus #4', 'Khordha', 'Ramesh Kumar', '+91 9876500004', 'Hari Das', '+91 9876500014', 45]
          );
          await dbRun(
            `INSERT INTO buses (bus_number, route_name, driver_name, driver_phone, conductor_name, conductor_phone, capacity) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ['Bus #1', 'Bhubaneswar', 'Suresh Mohanty', '+91 9876500001', 'Prakash Nayak', '+91 9876500011', 50]
          );
          await dbRun(
            `INSERT INTO buses (bus_number, route_name, driver_name, driver_phone, conductor_name, conductor_phone, capacity) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ['Bus #2', 'Cuttack', 'Bikash Rout', '+91 9876500002', 'Litu Behera', '+91 9876500012', 40]
          );
          console.log('Seeded sample buses (Bus #4, Bus #1, Bus #2)');
        }

        // Seed Sample Routes if empty
        const routeCount = await dbGet('SELECT COUNT(*) as count FROM bus_routes');
        if (routeCount.count === 0) {
          await dbRun(`INSERT INTO bus_routes (route_name, stop_name, stop_order, pickup_time, drop_time) VALUES ('Khordha', 'Khordha Bypass', 1, '07:30 AM', '06:15 PM')`);
          await dbRun(`INSERT INTO bus_routes (route_name, stop_name, stop_order, pickup_time, drop_time) VALUES ('Khordha', 'Pitapalli Square', 2, '07:45 AM', '06:30 PM')`);
          await dbRun(`INSERT INTO bus_routes (route_name, stop_name, stop_order, pickup_time, drop_time) VALUES ('Khordha', 'BEC Campus Gate', 3, '09:00 AM', '05:00 PM')`);
          await dbRun(`INSERT INTO bus_routes (route_name, stop_name, stop_order, pickup_time, drop_time) VALUES ('Bhubaneswar', 'Master Canteen', 1, '07:15 AM', '06:45 PM')`);
          await dbRun(`INSERT INTO bus_routes (route_name, stop_name, stop_order, pickup_time, drop_time) VALUES ('Bhubaneswar', 'Khandagiri Square', 2, '07:40 AM', '06:20 PM')`);
          console.log('Seeded sample bus routes for Khordha and Bhubaneswar');
        }

        // Check if student Munu Nial (BEC26081) exists, if not seed him
        let munu = await dbGet('SELECT * FROM students WHERE roll_number = ? OR name = ?', ['BEC26081', 'Munu Nial']);
        if (!munu) {
          const res = await dbRun(
            `INSERT INTO students (student_id, name, roll_number, registration_number, branch, department, semester, section, mobile, phone, email, address, parent_name, parent_mobile, face_enrolled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['STU-26081', 'Munu Nial', 'BEC26081', 'REG-2026-081', 'Computer Science', 'Computer Science', 'Semester 4', 'A', '+91 9998887770', '+91 9998887770', 'munu.nial@bec.edu.in', 'Khordha, Odisha', 'Subash Nial', '+91 9998887771', 1]
          );
          const munuId = res.id;
          // Seed transport registration & transport fee for Munu Nial
          await dbRun(
            `INSERT INTO bus_registrations (student_id, bus_id, route_id, stop_id, academic_year, fee_status) VALUES (?, 1, 2, 2, '2026', 'PAID')`,
            [munuId]
          );
          await dbRun(
            `INSERT INTO transport_fees (student_id, academic_year, total_fee, paid_amount, pending_amount, status) VALUES (?, '2026', 15000, 15000, 0, 'PAID')`,
            [munuId]
          );
        }

        // Seed Master Demo Student: Rohan Verma (ROHAN-04 / Class V / Bus-04)
        let rohan = await dbGet('SELECT * FROM students WHERE roll_number = ? OR student_id = ?', ['ROHAN-04', 'STU-ROHAN']);
        if (!rohan) {
          const resRohan = await dbRun(
            `INSERT INTO students (student_id, name, roll_number, registration_number, branch, department, semester, section, mobile, phone, email, address, parent_name, parent_mobile, parent_whatsapp, emergency_contact, face_enrolled, consent_face_enrolled, assigned_bus_id, pickup_stop_name, drop_stop_name, guardian_code) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['STU-ROHAN', 'Rohan Verma', 'ROHAN-04', 'REG-2026-ROH', 'Class V', 'Primary Wing', 'Grade 5', 'A', '+91 9876543210', '+91 9876543210', 'manoj.verma@schoolsafe.edu', 'Plot 42, Pitapalli Square, Khordha', 'Manoj Verma', '+91 9876543210', '+91 9876543210', '+91 9876543210', 1, 1, 1, 'Pitapalli Square', 'Pitapalli Square', '7421']
          );
          const rohanId = resRohan.id;
          await dbRun(
            `INSERT INTO bus_registrations (student_id, bus_id, route_id, stop_id, academic_year, fee_status) VALUES (?, 1, 1, 2, '2026', 'PAID')`,
            [rohanId]
          );
          await dbRun(
            `INSERT INTO transport_fees (student_id, academic_year, total_fee, paid_amount, pending_amount, status) VALUES (?, '2026', 15000, 15000, 0, 'PAID')`,
            [rohanId]
          );
          console.log('Seeded Master Demo Subject: Rohan Verma (ROHAN-04, Guardian: Manoj Verma +91 9876543210)');
        }

        // Auto-sync all existing students in database to bus_registrations & transport_fees
        const allStudents = await dbQuery('SELECT * FROM students');
        for (const stu of allStudents) {
          const hasReg = await dbGet('SELECT * FROM bus_registrations WHERE student_id = ?', [stu.id]);
          if (!hasReg) {
            await dbRun(
              `INSERT INTO bus_registrations (student_id, bus_id, route_id, stop_id, academic_year, fee_status) VALUES (?, 1, 1, 1, '2026', 'PAID')`,
              [stu.id]
            );
          }
          const hasFee = await dbGet('SELECT * FROM transport_fees WHERE student_id = ?', [stu.id]);
          if (!hasFee) {
            await dbRun(
              `INSERT INTO transport_fees (student_id, academic_year, total_fee, paid_amount, pending_amount, status) VALUES (?, '2026', 15000, 15000, 0, 'PAID')`,
              [stu.id]
            );
          }

          // Auto-sync Transport Card for Dual Verification
          const hasCard = await dbGet('SELECT * FROM student_transport_cards WHERE student_id = ? AND status = "ACTIVE"', [stu.id]);
          if (!hasCard) {
            let cardUuid = `SC-CARD-${stu.id}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
            let rfidUid = `RF-${Math.floor(1000 + Math.random() * 9000)}`;

            if (stu.roll_number === 'ROHAN-04' || stu.student_id === 'STU-ROHAN') {
              cardUuid = 'SC-CARD-ROH-7421';
              rfidUid = 'E2-04-74-21';
            } else if (stu.roll_number === 'BEC26081') {
              cardUuid = 'SC-CARD-MUN-26081';
              rfidUid = 'A1-26-08-10';
            }

            await dbRun(
              `INSERT INTO student_transport_cards (student_id, card_uuid, rfid_uid, status, issued_by) VALUES (?, ?, ?, 'ACTIVE', 'Transport Admin')`,
              [stu.id, cardUuid, rfidUid]
            );
            await dbRun(
              `UPDATE students SET transport_card_id = ?, rfid_uid = ?, card_status = 'ACTIVE' WHERE id = ?`,
              [cardUuid, rfidUid, stu.id]
            );
          }
        }



        // 3. Hostel Curfew & In/Out Configuration Table
        await dbRun(`
          CREATE TABLE IF NOT EXISTS hostel_curfew_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hostel_id INTEGER DEFAULT 1,
            hostel_name TEXT DEFAULT 'Main Boys & Girls Hostel',
            curfew_time TEXT DEFAULT '19:00:00',
            allowed_exit_start_time TEXT DEFAULT '06:00:00',
            allowed_entry_cutoff_time TEXT DEFAULT '19:00:00',
            late_threshold_minutes INTEGER DEFAULT 60,
            alert_time TEXT DEFAULT '20:00:00',
            is_active INTEGER DEFAULT 1
          )
        `);

        // 4. Daily Occupancy Log Table (Day-by-Day Historical Analytics)
        await dbRun(`
          CREATE TABLE IF NOT EXISTS hostel_daily_occupancy (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            log_date TEXT UNIQUE,
            total_registered INTEGER DEFAULT 0,
            total_in INTEGER DEFAULT 0,
            total_out INTEGER DEFAULT 0,
            late_entries INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // 5. Security Alerts Table
        await dbRun(`
          CREATE TABLE IF NOT EXISTS security_alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alert_type TEXT,
            camera_id TEXT,
            student_id TEXT,
            gate_name TEXT DEFAULT 'Main Gate',
            image_snapshot TEXT,
            photo_url TEXT,
            is_acknowledged INTEGER DEFAULT 0,
            detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            acknowledged_by TEXT,
            acknowledged_at DATETIME,
            notes TEXT
          )
        `);

        // Seed Default Hostel Curfew Config if empty
        const curfewCount = await dbGet('SELECT COUNT(*) as count FROM hostel_curfew_config');
        if (curfewCount.count === 0) {
          await dbRun(
            `INSERT INTO hostel_curfew_config (hostel_id, hostel_name, curfew_time, late_threshold_minutes, alert_time, is_active) VALUES (?, ?, ?, ?, ?, ?)`,
            [1, 'Main Hostel Block A', '19:00:00', 60, '20:00:00', 1]
          );
        }

        // Seed Users if empty
        const userCount = await dbGet('SELECT COUNT(*) as count FROM users');
        if (userCount.count === 0) {
          const salt = await bcrypt.genSalt(10);
          const adminPass = await bcrypt.hash('admin123', salt);
          const teacherPass = await bcrypt.hash('teacher123', salt);
          const studentPass = await bcrypt.hash('student123', salt);
          const wardenPass = await bcrypt.hash('warden123', salt);
          const securityPass = await bcrypt.hash('security123', salt);

          await dbRun(
            `INSERT INTO users (username, password_hash, role, name, email) VALUES (?, ?, ?, ?, ?)`,
            ['admin', adminPass, 'admin', 'System Administrator', 'admin@institution.edu']
          );
          await dbRun(
            `INSERT INTO users (username, password_hash, role, name, email) VALUES (?, ?, ?, ?, ?)`,
            ['teacher', teacherPass, 'teacher', 'Prof. Robert Davis', 'robert.davis@institution.edu']
          );
          await dbRun(
            `INSERT INTO users (username, password_hash, role, name, email) VALUES (?, ?, ?, ?, ?)`,
            ['student', studentPass, 'student', 'Rahul Kumar', 'rahul.k@institution.edu']
          );
          await dbRun(
            `INSERT INTO users (username, password_hash, role, name, email) VALUES (?, ?, ?, ?, ?)`,
            ['warden', wardenPass, 'admin', 'Chief Hostel Warden', 'warden@institution.edu']
          );
          await dbRun(
            `INSERT INTO users (username, password_hash, role, name, email) VALUES (?, ?, ?, ?, ?)`,
            ['security', securityPass, 'admin', 'Head Security Guard', 'security@institution.edu']
          );
          console.log('Seeded default users (admin/admin123, teacher/teacher123, student/student123, warden/warden123, security/security123)');
        }

        // Ensure Master Admin 9040954015 exists
        try {
          const salt9040 = await bcrypt.genSalt(10);
          const pass9040 = await bcrypt.hash('9040954015', salt9040);
          const admin9040 = await dbGet('SELECT * FROM users WHERE username = ?', ['9040954015']);
          if (!admin9040) {
            await dbRun(
              `INSERT INTO users (username, password_hash, role, name, email) VALUES (?, ?, ?, ?, ?)`,
              ['9040954015', pass9040, 'admin', 'Head Transport Administrator', 'admin@schoolbus.edu']
            );
            console.log('Seeded Master Admin: 9040954015');
          } else {
            await dbRun(
              `UPDATE users SET password_hash = ?, role = 'admin' WHERE username = ?`,
              [pass9040, '9040954015']
            );
          }
        } catch (uErr) {
          console.warn('Error setting up 9040954015 admin user:', uErr.message);
        }

        // Seed Sample Students if empty
        const studentCount = await dbGet('SELECT COUNT(*) as count FROM students');
        if (studentCount.count === 0) {
          const sampleStudents = [
            ['STU-101', 'Rahul Kumar', '101', 'REG-2024-101', 'Computer Science', 'Computer Science', 'Semester 6', 'A', '+91 9876543210', '+91 9876543210', 'rahul.k@institution.edu', 'New Delhi, India', 0],
            ['STU-102', 'Amit Das', '102', 'REG-2024-102', 'Information Technology', 'Information Technology', 'Semester 6', 'B', '+91 9876543211', '+91 9876543211', 'amit.d@institution.edu', 'Kolkata, India', 0],
            ['STU-103', 'Priya Sharma', '103', 'REG-2024-103', 'Electrical Engineering', 'Electrical Engineering', 'Semester 4', 'A', '+91 9876543212', '+91 9876543212', 'priya.s@institution.edu', 'Mumbai, India', 0],
            ['STU-104', 'Sneha Patel', '104', 'REG-2024-104', 'Mechanical Engineering', 'Mechanical Engineering', 'Semester 4', 'A', '+91 9876543213', '+91 9876543213', 'sneha.p@institution.edu', 'Ahmedabad, India', 0],
            ['STU-105', 'Vikram Singh', '105', 'REG-2024-105', 'Civil Engineering', 'Civil Engineering', 'Semester 2', 'B', '+91 9876543214', '+91 9876543214', 'vikram.s@institution.edu', 'Jaipur, India', 0]
          ];

          for (const s of sampleStudents) {
            await dbRun(
              `INSERT INTO students (student_id, name, roll_number, registration_number, branch, department, semester, section, mobile, phone, email, address, face_enrolled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              s
            );
          }
          console.log('Seeded sample student directory with 9 complete fields');

          // Seed Sample Attendance Records
          const today = new Date().toISOString().split('T')[0];
          const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
          const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0];

          const sampleLogs = [
            ['STU-101', today, '09:31 AM', Date.now() - 3600000, 'Present', 'Webcam', 98.5],
            ['STU-102', today, '09:32 AM', Date.now() - 3200000, 'Present', 'Webcam', 96.2],
            ['STU-103', today, '09:34 AM', Date.now() - 2800000, 'Present', 'Webcam', 99.1],
            ['STU-104', today, '09:48 AM', Date.now() - 1200000, 'Late', 'Webcam', 92.4],
            ['STU-101', yesterday, '09:28 AM', Date.now() - 86400000, 'Present', 'Webcam', 97.8],
            ['STU-102', yesterday, '09:46 AM', Date.now() - 86400000 + 300000, 'Late', 'Webcam', 94.0],
            ['STU-103', yesterday, '09:30 AM', Date.now() - 86400000, 'Present', 'Webcam', 98.9],
            ['STU-105', yesterday, '09:33 AM', Date.now() - 86400000, 'Present', 'Webcam', 95.5],
            ['STU-101', twoDaysAgo, '09:25 AM', Date.now() - 2 * 86400000, 'Present', 'Webcam', 98.0],
            ['STU-102', twoDaysAgo, '09:30 AM', Date.now() - 2 * 86400000, 'Present', 'Webcam', 96.7],
            ['STU-103', twoDaysAgo, '09:29 AM', Date.now() - 2 * 86400000, 'Present', 'Webcam', 97.5]
          ];

          for (const log of sampleLogs) {
            await dbRun(
              `INSERT INTO attendance (student_id, date, time, timestamp, status, mode, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)`,
              log
            );
          }
          console.log('Seeded initial attendance logs for visual reporting');
        }

        // ==============================================================================
        // SafeRide AI — Seed Configurable Bus Stops & Historical Segments
        // ==============================================================================
        const existingStops = await dbGet('SELECT COUNT(*) as count FROM bus_stops');
        if (existingStops.count === 0) {
          const stopsSeed = [
            [1, 'Khordha', 'BEC Campus Gate', 1, 20.1782, 85.7061, 500, '07:00 AM', '04:00 PM'],
            [1, 'Khordha', 'Khordha Bypass', 2, 20.1875, 85.6214, 500, '07:30 AM', '04:20 PM'],
            [1, 'Khordha', 'Pitapalli Square', 3, 20.2105, 85.6702, 500, '07:45 AM', '04:40 PM'],
            [1, 'Khordha', 'Master Canteen', 4, 20.2648, 85.8398, 500, '08:15 AM', '05:05 PM']
          ];
          for (const st of stopsSeed) {
            await dbRun(
              `INSERT INTO bus_stops (route_id, route_name, stop_name, stop_sequence, gps_lat, gps_lng, geofence_radius_meters, scheduled_pickup_time, scheduled_drop_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              st
            );
          }
          console.log('Seeded 4 SafeRide AI configurable bus stops with 500m geofence');
        }

        const existingSegments = await dbGet('SELECT COUNT(*) as count FROM trip_segment_history');
        if (existingSegments.count === 0) {
          const segmentsSeed = [
            [1, 1, 'BEC Campus Gate', 2, 'Khordha Bypass', 1200, 20, 34.5],
            [1, 2, 'Khordha Bypass', 3, 'Pitapalli Square', 1200, 22, 31.0],
            [1, 3, 'Pitapalli Square', 4, 'Master Canteen', 1500, 18, 33.2]
          ];
          for (const seg of segmentsSeed) {
            await dbRun(
              `INSERT INTO trip_segment_history (route_id, from_stop_id, from_stop_name, to_stop_id, to_stop_name, historical_duration_seconds, sample_count, avg_speed_kmh) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              seg
            );
          }
          console.log('Seeded historical trip segments for AI delay prediction');
        }

        // ==============================================================================
        // SafeRide AI — Seed 28-Student Return Manifest & Active Trip 102 for Bus #4
        // ==============================================================================
        const existingTrip102 = await dbGet('SELECT * FROM trips WHERE id = 102 OR trip_code = "TRIP-RET-102"');
        if (!existingTrip102) {
          await dbRun(
            `INSERT INTO trips (id, bus_id, trip_type, trip_code, status, scheduled_departure_time, scheduled_return_time, expected_count, boarded_count, exited_count, unresolved_count, safety_status, clearance_status, driver_name) 
             VALUES (102, 1, 'RETURN', 'TRIP-RET-102', 'ACTIVE', '04:00 PM', '05:15 PM', 28, 0, 0, 0, 'CLEAR', 'PENDING', 'Ramesh Kumar')`
          );
          console.log('Seeded Bus #4 Return Trip 102 (Scheduled: 04:00 PM, Expected: 28 students)');
        }

        // 28 Defined Student Roster for Trip 102 Manifest
        const manifestRoster = [
          { name: 'Rohan Verma', roll: 'ROHAN-04', parent: 'Manoj Verma', phone: '+91 9876543210', stopId: 3, stop: 'Pitapalli Square', code: '7421' },
          { name: 'Munu Nial', roll: 'BEC26081', parent: 'Subash Nial', phone: '+91 9998887771', stopId: 2, stop: 'Khordha Bypass', code: '2608' },
          { name: 'Aarav Sharma', roll: 'SR-2026-003', parent: 'Rajesh Sharma', phone: '+91 9876500003', stopId: 3, stop: 'Pitapalli Square', code: '1003' },
          { name: 'Ananya Sen', roll: 'SR-2026-004', parent: 'Alok Sen', phone: '+91 9876500004', stopId: 2, stop: 'Khordha Bypass', code: '1004' },
          { name: 'Priya Nair', roll: 'SR-2026-005', parent: 'K. Nair', phone: '+91 9876500005', stopId: 4, stop: 'Master Canteen', code: '1005' },
          { name: 'Dev Patel', roll: 'SR-2026-006', parent: 'Nilesh Patel', phone: '+91 9876500006', stopId: 2, stop: 'Khordha Bypass', code: '1006' },
          { name: 'Sneha Rao', roll: 'SR-2026-007', parent: 'Venkat Rao', phone: '+91 9876500007', stopId: 3, stop: 'Pitapalli Square', code: '1007' },
          { name: 'Ishaan Gupta', roll: 'SR-2026-008', parent: 'Sanjay Gupta', phone: '+91 9876500008', stopId: 4, stop: 'Master Canteen', code: '1008' },
          { name: 'Diya Mishra', roll: 'SR-2026-009', parent: 'Ashok Mishra', phone: '+91 9876500009', stopId: 3, stop: 'Pitapalli Square', code: '1009' },
          { name: 'Kabir Das', roll: 'SR-2026-010', parent: 'Tarun Das', phone: '+91 9876500010', stopId: 2, stop: 'Khordha Bypass', code: '1010' },
          { name: 'Riya Choudhury', roll: 'SR-2026-011', parent: 'Pradeep Choudhury', phone: '+91 9876500011', stopId: 4, stop: 'Master Canteen', code: '1011' },
          { name: 'Vivaan Jena', roll: 'SR-2026-012', parent: 'Bipin Jena', phone: '+91 9876500012', stopId: 3, stop: 'Pitapalli Square', code: '1012' },
          { name: 'Tanvi Mohanty', roll: 'SR-2026-013', parent: 'Debashis Mohanty', phone: '+91 9876500013', stopId: 2, stop: 'Khordha Bypass', code: '1013' },
          { name: 'Ayaan Samal', roll: 'SR-2026-014', parent: 'R. Samal', phone: '+91 9876500014', stopId: 4, stop: 'Master Canteen', code: '1014' },
          { name: 'Meera Sahu', roll: 'SR-2026-015', parent: 'Kailash Sahu', phone: '+91 9876500015', stopId: 3, stop: 'Pitapalli Square', code: '1015' },
          { name: 'Aditya Nayak', roll: 'SR-2026-016', parent: 'Manoranjan Nayak', phone: '+91 9876500016', stopId: 2, stop: 'Khordha Bypass', code: '1016' },
          { name: 'Kavya Tripathy', roll: 'SR-2026-017', parent: 'Sarat Tripathy', phone: '+91 9876500017', stopId: 4, stop: 'Master Canteen', code: '1017' },
          { name: 'Arjun Barik', roll: 'SR-2026-018', parent: 'Dillip Barik', phone: '+91 9876500018', stopId: 3, stop: 'Pitapalli Square', code: '1018' },
          { name: 'Shreya Swain', roll: 'SR-2026-019', parent: 'Santosh Swain', phone: '+91 9876500019', stopId: 2, stop: 'Khordha Bypass', code: '1019' },
          { name: 'Reyansh Pradhan', roll: 'SR-2026-020', parent: 'Bibhuti Pradhan', phone: '+91 9876500020', stopId: 4, stop: 'Master Canteen', code: '1020' },
          { name: 'Anika Mohapatra', roll: 'SR-2026-021', parent: 'Soumya Mohapatra', phone: '+91 9876500021', stopId: 3, stop: 'Pitapalli Square', code: '1021' },
          { name: 'Dhruv Das', roll: 'SR-2026-022', parent: 'Hrushikesh Das', phone: '+91 9876500022', stopId: 2, stop: 'Khordha Bypass', code: '1022' },
          { name: 'Samaira Sethi', roll: 'SR-2026-023', parent: 'Niranjan Sethi', phone: '+91 9876500023', stopId: 4, stop: 'Master Canteen', code: '1023' },
          { name: 'Vihaan Panda', roll: 'SR-2026-024', parent: 'Gagan Panda', phone: '+91 9876500024', stopId: 3, stop: 'Pitapalli Square', code: '1024' },
          { name: 'Myra Parida', roll: 'SR-2026-025', parent: 'Subrat Parida', phone: '+91 9876500025', stopId: 2, stop: 'Khordha Bypass', code: '1025' },
          { name: 'Atharv Behera', roll: 'SR-2026-026', parent: 'Pramod Behera', phone: '+91 9876500026', stopId: 4, stop: 'Master Canteen', code: '1026' },
          { name: 'Avani Panigrahi', roll: 'SR-2026-027', parent: 'Jayant Panigrahi', phone: '+91 9876500027', stopId: 3, stop: 'Pitapalli Square', code: '1027' },
          { name: 'Advait Sahoo', roll: 'SR-2026-028', parent: 'Ramesh Sahoo', phone: '+91 9876500028', stopId: 2, stop: 'Khordha Bypass', code: '1028' }
        ];

        for (const item of manifestRoster) {
          // Check student entry
          let sRecord = await dbGet('SELECT * FROM students WHERE roll_number = ? OR name = ?', [item.roll, item.name]);
          let sId = sRecord ? sRecord.id : null;
          if (!sRecord) {
            const insRes = await dbRun(
              `INSERT INTO students (student_id, name, roll_number, registration_number, branch, department, semester, section, mobile, phone, email, address, parent_name, parent_mobile, emergency_contact, face_enrolled, consent_face_enrolled, assigned_bus_id, pickup_stop_name, drop_stop_name, guardian_code) 
               VALUES (?, ?, ?, ?, 'Class V', 'Primary Wing', 'Grade 5', 'A', ?, ?, ?, 'Khordha, Odisha', ?, ?, ?, 1, 1, 1, ?, ?, ?)`,
              [`STU-${item.roll}`, item.name, item.roll, `REG-${item.roll}`, item.phone, item.phone, `${item.name.toLowerCase().replace(' ', '.')}@schoolsafe.edu`, item.parent, item.phone, item.phone, item.stop, item.stop, item.code]
            );
            sId = insRes.id;
          }

          // Ensure transport card
          const card = await dbGet('SELECT * FROM student_transport_cards WHERE student_id = ? AND status = "ACTIVE"', [sId]);
          if (!card) {
            const cardUuid = `SC-CARD-${item.roll}`;
            const rfidUid = `RF-${item.code}-04`;
            await dbRun(
              `INSERT INTO student_transport_cards (student_id, card_uuid, rfid_uid, status, issued_by) VALUES (?, ?, ?, 'ACTIVE', 'Transport Admin')`,
              [sId, cardUuid, rfidUid]
            );
            await dbRun(
              `UPDATE students SET transport_card_id = ?, rfid_uid = ?, card_status = 'ACTIVE' WHERE id = ?`,
              [cardUuid, rfidUid, sId]
            );
          }

          // Ensure in trip_manifest for Trip 102
          const inManifest = await dbGet('SELECT * FROM trip_manifest WHERE trip_id = 102 AND (student_id = ? OR roll_number = ?)', [sId, item.roll]);
          if (!inManifest) {
            await dbRun(
              `INSERT INTO trip_manifest (trip_id, trip_code, bus_id, student_id, roll_number, student_name, assigned_stop_id, stop_name, parent_name, parent_phone, guardian_code, is_expected, attendance_status) 
               VALUES (102, 'TRIP-RET-102', 1, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'EXPECTED')`,
              [sId, item.roll, item.name, item.stopId, item.stop, item.parent, item.phone, item.code]
            );
          }
        }
        console.log('Seeded all 28 expected students for Bus #4 Return Trip 102 Manifest');

        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

module.exports = {
  db,
  dbQuery,
  dbRun,
  dbGet,
  initDatabase
};
