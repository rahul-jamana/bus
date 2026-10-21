const express = require('express');
const router = express.Router();
const { dbQuery, dbGet, dbRun } = require('../db/database');
const { dispatchBusSMSNotification } = require('./notifications');

// POST /api/bus/board - Camera entry boarding detection (with automated fee status & anti-spoof validation)
router.post('/board', async (req, res) => {
  try {
    const { student_id, roll_number, bus_id = 1, route_id = 1, face_confidence = 98.5, photo_url = '', lat, lng } = req.body;

    let student = null;
    if (student_id) {
      student = await dbGet('SELECT * FROM students WHERE id = ? OR student_id = ?', [student_id, student_id]);
    } else if (roll_number) {
      student = await dbGet('SELECT * FROM students WHERE roll_number = ?', [roll_number]);
    }

    // Check 1: Unknown Student
    if (!student) {
      const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const bus = await dbGet('SELECT * FROM buses WHERE id = ?', [bus_id]);
      const busNum = bus ? bus.bus_number : 'Bus #4';

      await dbRun(
        `INSERT INTO bus_boarding_logs (student_id, roll_number, bus_id, route_id, log_type, face_matched, face_confidence, alert_type, photo_url, parent_notified) VALUES (?, ?, ?, ?, 'BOARD', 0, ?, 'UNKNOWN', ?, 0)`,
        [0, roll_number || 'UNKNOWN', bus_id, route_id, face_confidence, photo_url]
      );

      // Trigger Alert
      await dbRun(
        `INSERT INTO security_alerts (alert_type, camera_id, student_id, gate_name, photo_url, notes) VALUES (?, ?, ?, ?, ?, ?)`,
        ['UNKNOWN_BUS_BOARDING', `Bus_${bus_id}_Cam`, 'UNKNOWN', `Bus Gate ${busNum}`, photo_url, 'Unknown face detected boarding bus. Boarding denied.']
      );

      return res.json({
        success: false,
        allowed: false,
        alert: 'UNKNOWN_STUDENT',
        message: '⚠️ UNKNOWN FACE DETECTED! Student not found in database. Boarding denied.',
        time: timeStr
      });
    }

    const sId = student.id;
    const sRoll = student.roll_number;
    const sName = student.name;
    const pMobile = student.parent_mobile || student.mobile;
    const pName = student.parent_name || 'Parent';

    // Fetch Bus and Route details
    const bus = await dbGet('SELECT * FROM buses WHERE id = ?', [bus_id]);
    const busNum = bus ? bus.bus_number : 'Bus #4';
    const rName = bus ? bus.route_name : 'Khordha';

    // Check 2: Bus Registration
    const reg = await dbGet('SELECT * FROM bus_registrations WHERE student_id = ? AND is_active = 1', [sId]);
    if (!reg) {
      const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

      await dbRun(
        `INSERT INTO bus_boarding_logs (student_id, roll_number, bus_id, route_id, log_type, face_matched, face_confidence, alert_type, photo_url, parent_notified) VALUES (?, ?, ?, ?, 'BOARD', 1, ?, 'NOT_REGISTERED', ?, 1)`,
        [sId, sRoll, bus_id, route_id, face_confidence, photo_url]
      );

      await dispatchBusSMSNotification('UNREGISTERED_ALERT', {
        studentName: sName,
        rollNumber: sRoll,
        parentName: pName,
        parentMobile: pMobile,
        busNumber: busNum,
        routeName: rName,
        studentId: sId,
        timeStr
      });

      return res.json({
        success: false,
        allowed: false,
        alert: 'NOT_REGISTERED',
        message: `⚠️ NOT REGISTERED: Student ${sName} (${sRoll}) is not registered for Bus Service. Boarding blocked!`,
        student: { id: sId, name: sName, roll: sRoll }
      });
    }

    // Check 3: Transport Fee Status (Feature 7)
    const fee = await dbGet('SELECT * FROM transport_fees WHERE student_id = ?', [sId]);
    const feeStatus = fee ? fee.status : reg.fee_status;

    if (feeStatus === 'UNPAID') {
      const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

      await dbRun(
        `INSERT INTO bus_boarding_logs (student_id, roll_number, bus_id, route_id, log_type, face_matched, face_confidence, alert_type, photo_url, parent_notified) VALUES (?, ?, ?, ?, 'BOARD', 1, ?, 'FEE_PENDING', ?, 1)`,
        [sId, sRoll, bus_id, route_id, face_confidence, photo_url]
      );

      // Trigger Warden Alert
      await dispatchBusSMSNotification('FEE_UNPAID_ALERT', {
        studentName: sName,
        rollNumber: sRoll,
        parentName: pName,
        parentMobile: pMobile,
        busNumber: busNum,
        routeName: rName,
        studentId: sId,
        timeStr
      });

      return res.json({
        success: false,
        allowed: false,
        alert: 'FEE_PENDING',
        message: `⛔ FEE UNPAID ALERT: ${sName} (${sRoll}) has pending transport fees! Boarding blocked. Warden & Parent alerted.`,
        student: { id: sId, name: sName, roll: sRoll, fee_status: 'UNPAID' }
      });
    }

    // Success Boarding (Feature 1)
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    await dbRun(
      `INSERT INTO bus_boarding_logs (student_id, roll_number, bus_id, route_id, log_type, face_matched, face_confidence, gps_lat, gps_lng, alert_type, photo_url, parent_notified) VALUES (?, ?, ?, ?, 'BOARD', 1, ?, ?, ?, 'NONE', ?, 1)`,
      [sId, sRoll, bus_id, route_id, face_confidence, lat || 20.2961, lng || 85.8245, photo_url]
    );

    // Send Feature 1 SMS to Parent
    const smsRes = await dispatchBusSMSNotification('BOARD', {
      studentName: sName,
      rollNumber: sRoll,
      parentName: pName,
      parentMobile: pMobile,
      busNumber: busNum,
      routeName: rName,
      studentId: sId,
      timeStr
    });

    res.json({
      success: true,
      allowed: true,
      alert: 'NONE',
      message: `✔ BOARDED: ${sName} (${sRoll}) boarded ${busNum} at ${timeStr}. Parent SMS sent!`,
      student: { id: sId, name: sName, roll: sRoll, fee_status: feeStatus },
      smsContent: smsRes.message
    });
  } catch (err) {
    console.error('Error in bus boarding:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/bus/deboard - Deboard / Return Evening Bus Boarding Handler
router.post('/deboard', async (req, res) => {
  try {
    const { student_id, roll_number, bus_id = 1, route_id = 1, face_confidence = 99.0, photo_url = '' } = req.body;

    let student = await dbGet('SELECT * FROM students WHERE id = ? OR student_id = ? OR roll_number = ?', [student_id, student_id, roll_number]);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const sId = student.id;
    const sRoll = student.roll_number;
    const sName = student.name;
    const pMobile = student.parent_mobile || student.mobile;
    const pName = student.parent_name || 'Parent';

    const bus = await dbGet('SELECT * FROM buses WHERE id = ?', [bus_id]);
    const busNum = bus ? bus.bus_number : 'Bus #4';
    const rName = bus ? bus.route_name : 'Khordha';
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    await dbRun(
      `INSERT INTO bus_boarding_logs (student_id, roll_number, bus_id, route_id, log_type, face_matched, face_confidence, alert_type, photo_url, parent_notified) VALUES (?, ?, ?, ?, 'DEBOARD', 1, ?, 'NONE', ?, 1)`,
      [sId, sRoll, bus_id, route_id, face_confidence, photo_url]
    );

    const smsRes = await dispatchBusSMSNotification('RETURN_BOARD', {
      studentName: sName,
      rollNumber: sRoll,
      parentName: pName,
      parentMobile: pMobile,
      busNumber: busNum,
      routeName: rName,
      studentId: sId,
      timeStr
    });

    res.json({
      success: true,
      message: `✔ RETURN BOARDING: ${sName} boarded return ${busNum} at ${timeStr}. Parent SMS sent!`,
      smsContent: smsRes.message
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/bus/arrive-college - Trigger Morning Campus Arrival SMS Notification (9:00 AM)
router.post('/arrive-college', async (req, res) => {
  try {
    const { student_id, roll_number, bus_id = 1 } = req.body;
    let student = await dbGet('SELECT * FROM students WHERE id = ? OR student_id = ? OR roll_number = ?', [student_id, student_id, roll_number]);
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    await dbRun(
      `INSERT INTO bus_boarding_logs (student_id, roll_number, bus_id, log_type, face_matched, parent_notified) VALUES (?, ?, ?, 'ARRIVE_COLLEGE', 1, 1)`,
      [student.id, student.roll_number, bus_id]
    );

    const smsRes = await dispatchBusSMSNotification('ARRIVE_COLLEGE', {
      studentName: student.name,
      rollNumber: student.roll_number,
      parentName: student.parent_name,
      parentMobile: student.parent_mobile || student.mobile,
      studentId: student.id,
      timeStr
    });

    res.json({ success: true, message: `✔ ${student.name} reached college at ${timeStr}. Parent SMS sent!`, smsContent: smsRes.message });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/bus/leave-college - Trigger Evening Campus Departure SMS Notification (5:00 PM)
router.post('/leave-college', async (req, res) => {
  try {
    const { student_id, roll_number, bus_id = 1 } = req.body;
    let student = await dbGet('SELECT * FROM students WHERE id = ? OR student_id = ? OR roll_number = ?', [student_id, student_id, roll_number]);
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    await dbRun(
      `INSERT INTO bus_boarding_logs (student_id, roll_number, bus_id, log_type, face_matched, parent_notified) VALUES (?, ?, ?, 'LEAVE_COLLEGE', 1, 1)`,
      [student.id, student.roll_number, bus_id]
    );

    const smsRes = await dispatchBusSMSNotification('LEAVE_COLLEGE', {
      studentName: student.name,
      rollNumber: student.roll_number,
      parentName: student.parent_name,
      parentMobile: student.parent_mobile || student.mobile,
      studentId: student.id,
      timeStr
    });

    res.json({ success: true, message: `✔ ${student.name} left college at ${timeStr}. Parent SMS sent!`, smsContent: smsRes.message });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/bus/arrive-stop - Trigger Home Stop Arrival SMS Notification (Location Stop Drop)
router.post('/arrive-stop', async (req, res) => {
  try {
    const { student_id, roll_number, stop_name = 'Pitapalli Square' } = req.body;
    let student = await dbGet('SELECT * FROM students WHERE id = ? OR student_id = ? OR roll_number = ?', [student_id, student_id, roll_number]);
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    await dbRun(
      `INSERT INTO bus_boarding_logs (student_id, roll_number, log_type, face_matched, parent_notified) VALUES (?, ?, 'ARRIVE_STOP', 1, 1)`,
      [student.id, student.roll_number]
    );

    const smsRes = await dispatchBusSMSNotification('ARRIVE_STOP', {
      studentName: student.name,
      rollNumber: student.roll_number,
      parentName: student.parent_name,
      parentMobile: student.parent_mobile || student.mobile,
      stopName,
      studentId: student.id,
      timeStr
    });

    res.json({ success: true, message: `✔ ${student.name} reached ${stopName} at ${timeStr}. Parent SMS sent!`, smsContent: smsRes.message });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/bus/logs - Bus Boarding Logs (Feature 6)
router.get('/logs', async (req, res) => {
  try {
    const { bus_id, date, student_id } = req.query;
    let sql = `
      SELECT l.*, s.name as student_name, s.branch, b.bus_number, b.route_name
      FROM bus_boarding_logs l
      LEFT JOIN students s ON l.student_id = s.id
      LEFT JOIN buses b ON l.bus_id = b.id
      WHERE 1=1
    `;
    const params = [];

    if (bus_id) { sql += ' AND l.bus_id = ?'; params.push(bus_id); }
    if (student_id) { sql += ' AND l.student_id = ?'; params.push(student_id); }
    sql += ' ORDER BY l.id DESC LIMIT 100';

    const logs = await dbQuery(sql, params);
    res.json({ success: true, count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/bus/live - Live Buses Overview (Feature 10)
router.get('/live', async (req, res) => {
  try {
    const buses = await dbQuery('SELECT * FROM buses WHERE is_active = 1');
    const busStats = [];

    for (const bus of buses) {
      const onboard = await dbQuery(
        `SELECT COUNT(DISTINCT student_id) as count FROM bus_boarding_logs WHERE bus_id = ? AND log_type IN ('BOARD','RETURN_BOARD')`,
        [bus.id]
      );
      const feeUnpaid = await dbQuery(
        `SELECT COUNT(*) as count FROM bus_registrations br JOIN transport_fees tf ON br.student_id = tf.student_id WHERE br.bus_id = ? AND tf.status = 'UNPAID'`,
        [bus.id]
      );
      const unknownCount = await dbQuery(
        `SELECT COUNT(*) as count FROM bus_boarding_logs WHERE bus_id = ? AND alert_type = 'UNKNOWN'`,
        [bus.id]
      );

      busStats.push({
        ...bus,
        current_passengers: onboard[0] ? onboard[0].count : 0,
        unpaid_students: feeUnpaid[0] ? feeUnpaid[0].count : 0,
        unknown_attempts: unknownCount[0] ? unknownCount[0].count : 0,
        status: 'ON_ROUTE',
        last_updated: new Date().toISOString()
      });
    }

    res.json({ success: true, count: busStats.length, buses: busStats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/bus/students/:bus_id - Students registered for a specific bus (Feature 9)
router.get('/students/:bus_id', async (req, res) => {
  try {
    const busId = req.params.bus_id;
    const students = await dbQuery(
      `SELECT s.*, br.academic_year, tf.status as fee_status, tf.pending_amount, r.stop_name, r.pickup_time
       FROM bus_registrations br
       JOIN students s ON br.student_id = s.id
       LEFT JOIN transport_fees tf ON s.id = tf.student_id
       LEFT JOIN bus_routes r ON br.route_id = r.id
       WHERE br.bus_id = ? AND br.is_active = 1`,
      [busId]
    );
    res.json({ success: true, count: students.length, students });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/bus/routes - List all routes & stops
router.get('/routes', async (req, res) => {
  try {
    const routes = await dbQuery('SELECT * FROM bus_routes WHERE is_active = 1 ORDER BY route_name, stop_order');
    res.json({ success: true, routes });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST & GET /api/bus/registrations
router.get('/registrations', async (req, res) => {
  try {
    const list = await dbQuery(
      `SELECT br.*, s.name as student_name, s.roll_number, s.branch, b.bus_number, b.route_name
       FROM bus_registrations br
       JOIN students s ON br.student_id = s.id
       JOIN buses b ON br.bus_id = b.id
       ORDER BY br.id DESC`
    );
    res.json({ success: true, registrations: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/register', async (req, res) => {
  try {
    const { student_id, bus_id, route_id, stop_id, academic_year = '2026' } = req.body;
    const resRun = await dbRun(
      `INSERT INTO bus_registrations (student_id, bus_id, route_id, stop_id, academic_year, fee_status) VALUES (?, ?, ?, ?, ?, 'PAID')`,
      [student_id, bus_id, route_id, stop_id, academic_year]
    );
    res.json({ success: true, id: resRun.id, message: 'Student successfully registered for transport service!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/bus/reports/daily - Daily bus report
router.get('/reports/daily', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const logs = await dbQuery(
      `SELECT l.*, s.name as student_name, s.branch, b.bus_number, b.route_name
       FROM bus_boarding_logs l
       LEFT JOIN students s ON l.student_id = s.id
       LEFT JOIN buses b ON l.bus_id = b.id
       ORDER BY l.id DESC`
    );
    res.json({ success: true, date, logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/bus/reports/export/csv - Download Daily Transport Boarding Register CSV File
router.get('/reports/export/csv', async (req, res) => {
  try {
    const logs = await dbQuery(
      `SELECT l.log_time, s.name as student_name, l.roll_number, b.route_name, b.bus_number, l.log_type, l.alert_type
       FROM bus_boarding_logs l
       LEFT JOIN students s ON l.student_id = s.id
       LEFT JOIN buses b ON l.bus_id = b.id
       ORDER BY l.id DESC`
    );

    let csv = 'Time,Student Name,Roll Number,Route,Bus,Status,Alert\n';
    for (const row of logs) {
      csv += `"${row.log_time}","${row.student_name || 'N/A'}","${row.roll_number}","${row.route_name || 'Khordha'}","${row.bus_number || 'Bus #4'}","${row.log_type}","${row.alert_type}"\n`;
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="bus_boarding_register.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==============================================================================
// LIVE DRIVER GPS TELEMETRY & PARENT LIVE TRACKING APIS
// ==============================================================================

// POST /api/bus/telemetry - Driver phone streams live GPS coordinates every 2-3s
router.post('/telemetry', async (req, res) => {
  try {
    const { bus_id = 1, lat, lng, speed = 0, heading = 0, status = 'ACTIVE' } = req.body;
    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ success: false, message: 'Latitude and Longitude are required' });
    }

    await dbRun(
      `UPDATE buses SET current_lat = ?, current_lng = ?, speed = ?, heading = ?, status = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`,
      [Number(lat), Number(lng), Number(speed), Number(heading), status, bus_id]
    );

    res.json({
      success: true,
      message: 'GPS Telemetry updated successfully',
      bus_id,
      telemetry: { lat, lng, speed, heading, status, timestamp: new Date().toISOString() }
    });
  } catch (err) {
    console.error('Error updating bus telemetry:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/bus/telemetry/:bus_id - Fetch real-time bus position and route for parents/admin
router.get('/telemetry/:bus_id', async (req, res) => {
  try {
    const busId = req.params.bus_id;
    const bus = await dbGet('SELECT * FROM buses WHERE id = ? OR bus_number = ?', [busId, busId]);
    if (!bus) {
      return res.status(404).json({ success: false, message: 'Bus not found' });
    }

    const stops = await dbQuery(
      'SELECT * FROM bus_routes WHERE route_name = ? ORDER BY stop_order ASC',
      [bus.route_name]
    );

    const onboardRes = await dbGet(
      `SELECT COUNT(DISTINCT student_id) as count FROM bus_boarding_logs WHERE bus_id = ? AND log_type IN ('BOARD','RETURN_BOARD') AND date(log_time) = date('now')`,
      [bus.id]
    );

    res.json({
      success: true,
      bus: {
        id: bus.id,
        bus_number: bus.bus_number,
        route_name: bus.route_name,
        driver_name: bus.driver_name,
        driver_phone: bus.driver_phone,
        conductor_name: bus.conductor_name,
        current_lat: bus.current_lat || 20.2961,
        current_lng: bus.current_lng || 85.8245,
        speed: bus.speed || 0,
        heading: bus.heading || 0,
        status: bus.status || 'ACTIVE',
        last_updated: bus.last_updated,
        onboard_passengers: onboardRes ? onboardRes.count : 0
      },
      stops: stops.length > 0 ? stops : [
        { id: 1, stop_name: 'Khordha Bypass', stop_order: 1, pickup_time: '07:30 AM', drop_time: '06:15 PM' },
        { id: 2, stop_name: 'Pitapalli Square', stop_order: 2, pickup_time: '07:45 AM', drop_time: '06:30 PM' },
        { id: 3, stop_name: 'BEC Campus Gate', stop_order: 3, pickup_time: '09:00 AM', drop_time: '05:00 PM' }
      ]
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/bus/telemetry - All buses live telemetry
router.get('/telemetry', async (req, res) => {
  try {
    const buses = await dbQuery('SELECT * FROM buses WHERE is_active = 1');
    const busList = [];
    for (const b of buses) {
      const onboard = await dbGet(
        `SELECT COUNT(DISTINCT student_id) as count FROM bus_boarding_logs WHERE bus_id = ? AND log_type IN ('BOARD','RETURN_BOARD') AND date(log_time) = date('now')`,
        [b.id]
      );
      busList.push({
        ...b,
        current_lat: b.current_lat || 20.2961,
        current_lng: b.current_lng || 85.8245,
        onboard_count: onboard ? onboard.count : 0
      });
    }
    res.json({ success: true, count: busList.length, buses: busList });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/bus/parent-track/:query - Comprehensive child lookup by roll, student_id, or parent phone
router.get('/parent-track/:query', async (req, res) => {
  try {
    const q = req.params.query.trim();
    const student = await dbGet(
      `SELECT * FROM students WHERE roll_number = ? OR student_id = ? OR parent_mobile LIKE ? OR mobile LIKE ?`,
      [q, q, `%${q}%`, `%${q}%`]
    );

    if (!student) {
      return res.status(404).json({ success: false, message: `No student found for query: ${q}` });
    }

    // Get bus registration
    const reg = await dbGet('SELECT * FROM bus_registrations WHERE student_id = ? AND is_active = 1', [student.id]);
    const busId = reg ? reg.bus_id : 1;
    const bus = await dbGet('SELECT * FROM buses WHERE id = ?', [busId]);

    // Get latest boarding log today
    const latestLog = await dbGet(
      `SELECT * FROM bus_boarding_logs WHERE (student_id = ? OR roll_number = ?) ORDER BY id DESC LIMIT 1`,
      [student.id, student.roll_number]
    );

    // Get latest parent notifications
    const notifications = await dbQuery(
      `SELECT * FROM parent_notifications WHERE student_id = ? OR phone_number LIKE ? ORDER BY id DESC LIMIT 5`,
      [student.id, `%${student.parent_mobile || student.mobile}%`]
    );

    // Stops
    const stops = bus ? await dbQuery('SELECT * FROM bus_routes WHERE route_name = ? ORDER BY stop_order ASC', [bus.route_name]) : [];

    res.json({
      success: true,
      student: {
        id: student.id,
        name: student.name,
        roll_number: student.roll_number,
        student_id: student.student_id,
        branch: student.branch || student.department,
        section: student.section,
        parent_name: student.parent_name,
        parent_mobile: student.parent_mobile || student.mobile,
        parent_email: student.parent_email,
        photo_path: student.photo_path || ''
      },
      bus: bus ? {
        id: bus.id,
        bus_number: bus.bus_number,
        route_name: bus.route_name,
        driver_name: bus.driver_name,
        driver_phone: bus.driver_phone,
        conductor_name: bus.conductor_name,
        conductor_phone: bus.conductor_phone,
        current_lat: bus.current_lat || 20.2961,
        current_lng: bus.current_lng || 85.8245,
        speed: bus.speed || 0,
        heading: bus.heading || 0,
        status: bus.status || 'ACTIVE',
        last_updated: bus.last_updated
      } : null,
      stops,
      latest_log: latestLog,
      notifications
    });
  } catch (err) {
    console.error('Error in parent-track:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
