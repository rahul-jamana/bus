const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { dbQuery, dbGet, dbRun } = require('../db/database');
const { dispatchParentNotifications } = require('./notifications');

// Connect to Authoritative MySQL Student & Hostel Master
let mysqlPool = null;
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', 'campus-portal', '.env') });
  const dbModule = require('../../campus-portal/config/db');
  mysqlPool = dbModule.pool;
} catch (e) {
  console.warn('MySQL pool initialization error in gate.js:', e.message);
}

// In-Memory Debounce Cache (prevents duplicate logs when student faces camera for multiple seconds)
const gateDebounceMap = new Map();

const GATE_UPLOADS_DIR = path.join(__dirname, '..', 'uploads', 'gate_logs');
if (!fs.existsSync(GATE_UPLOADS_DIR)) {
  fs.mkdirSync(GATE_UPLOADS_DIR, { recursive: true });
}

// Helper: Query student and dynamic hostel allocation from Authoritative MySQL
async function getAuthoritativeStudent(sId) {
  if (!sId || sId === 'UNKNOWN') return null;
  if (!mysqlPool) {
    // Fallback safely to SQLite cached mirror
    return await dbGet('SELECT * FROM students WHERE student_id = ? OR roll_number = ?', [sId, sId]);
  }

  const [rows] = await mysqlPool.query(`
    SELECT 
      s.id as student_master_id,
      COALESCE(s.student_id, CONCAT('STU-', s.id)) as student_id,
      s.roll_number,
      s.full_name as name,
      s.branch,
      s.semester,
      s.phone,
      s.email,
      s.photo_url,
      sa.id as allocation_id,
      sa.status as allocation_status,
      h.id as hostel_id,
      h.name as hostel_name,
      r.room_number,
      b.bed_number
    FROM students s
    LEFT JOIN student_allocations sa ON (s.id = sa.student_id OR s.student_id = sa.student_id OR s.roll_number = sa.student_id) AND sa.status = 'ACTIVE'
    LEFT JOIN rooms r ON sa.room_id = r.id
    LEFT JOIN hostels h ON r.hostel_id = h.id
    LEFT JOIN beds b ON sa.bed_id = b.id
    WHERE (s.student_id = ? OR s.roll_number = ? OR s.id = ?)
    LIMIT 1
  `, [sId, sId, sId]);

  if (rows.length > 0) return rows[0];
  // Check local mirror if not found in query
  return await dbGet('SELECT * FROM students WHERE student_id = ? OR roll_number = ?', [sId, sId]);
}

// POST /api/gate/entry - Process Camera 1 (ENTRY)
router.post('/entry', async (req, res) => {
  try {
    const { student_id, studentId, confidence, anti_spoof_passed, snapshot_base64, gate_name } = req.body;
    const sId = (studentId || student_id || '').toString().trim();
    const conf = confidence || 95.0;
    const gate = gate_name || 'Hostel Gate 1 (Entry)';
    const camId = 'CAMERA_1_ENTRY';

    let photoPath = '';
    if (snapshot_base64) {
      const base64Data = snapshot_base64.replace(/^data:image\/\w+;base64,/, '');
      const fileName = `entry_${sId || 'unknown'}_${Date.now()}.jpg`;
      const relativePath = path.join('uploads', 'gate_logs', fileName).replace(/\\/g, '/');
      const fullPath = path.join(__dirname, '..', relativePath);
      fs.writeFileSync(fullPath, base64Data, { encoding: 'base64' });
      photoPath = '/' + relativePath;
    }

    // 1. UNKNOWN PERSON / NO MATCH: Security alert only, NO entry event
    if (!sId || sId === 'UNKNOWN' || sId.startsWith('UNKNOWN')) {
      await dbRun(
        `INSERT INTO security_alerts (alert_type, camera_id, gate_name, photo_url, notes) VALUES (?, ?, ?, ?, ?)`,
        ['UNKNOWN', camId, gate, photoPath, `Unrecognized person at entry gate: ${sId || 'NO_ID'}`]
      );

      await dbRun(
        `INSERT INTO gate_entry_exit_logs (student_id, log_type, camera_id, gate_name, face_matched, alert_type, photo_url, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['UNKNOWN', 'ENTRY', camId, gate, 0, 'UNKNOWN', photoPath, 'Unknown person at Entry camera - Gate access denied']
      );

      return res.status(403).json({
        success: false,
        alert: 'UNKNOWN',
        security_alert: true,
        message: '🚨 Unknown person detected at Gate! Security alert generated.'
      });
    }

    // 2. ANTI-SPOOF / LIVENESS FAILURE: Alert only, NO entry event
    if (anti_spoof_passed === false || anti_spoof_passed === 0) {
      await dbRun(
        `INSERT INTO security_alerts (alert_type, camera_id, gate_name, photo_url, student_id, notes) VALUES (?, ?, ?, ?, ?, ?)`,
        ['SPOOF_FAILED', camId, gate, photoPath, sId, `Liveness / anti-spoof check failed at Entry camera for ID: ${sId}`]
      );
      return res.status(403).json({
        success: false,
        alert: 'SPOOF_FAILED',
        security_alert: true,
        message: '🚨 Anti-spoofing check failed! Photo/screen detected. Gate access denied.'
      });
    }

    // 3. FETCH AUTHORITATIVE STUDENT & CURRENT HOSTEL ALLOCATION FROM MYSQL
    const student = await getAuthoritativeStudent(sId);
    if (!student) {
      await dbRun(
        `INSERT INTO security_alerts (alert_type, camera_id, gate_name, photo_url, notes) VALUES (?, ?, ?, ?, ?)`,
        ['UNKNOWN', camId, gate, photoPath, `Unregistered student ID "${sId}" detected at entry gate`]
      );
      return res.status(403).json({
        success: false,
        alert: 'UNKNOWN',
        security_alert: true,
        message: `Student ID "${sId}" not found in authoritative database. Security alert created.`
      });
    }

    const currentHostel = student.hostel_name || 'Main Hostel';
    const currentRoom = student.room_number ? `${student.room_number}${student.bed_number ? ' (' + student.bed_number + ')' : ''}` : 'N/A';

    // 4. VALIDATE THAT STUDENT IS VALIDLY REGISTERED IN FACE SYSTEM
    const faceCountRow = await dbGet('SELECT COUNT(*) as cnt FROM face_embeddings WHERE student_id = ?', [student.student_id]);
    const sfdRow = await dbGet('SELECT status FROM student_face_data WHERE student_id = ? OR roll_number = ?', [student.student_id, student.roll_number]);
    const isRegistered = (faceCountRow && faceCountRow.cnt > 0) && (!sfdRow || sfdRow.status !== 'FAILED');

    if (!isRegistered) {
      await dbRun(
        `INSERT INTO security_alerts (alert_type, camera_id, gate_name, photo_url, student_id, notes) VALUES (?, ?, ?, ?, ?, ?)`,
        ['UNREGISTERED_STUDENT', camId, gate, photoPath, student.student_id, `${student.name} (${student.roll_number}) face registration is PENDING`]
      );
      return res.status(403).json({
        success: false,
        alert: 'PENDING',
        message: `Face registration pending for ${student.name}. Gate entry not permitted.`
      });
    }

    // 5. GATE STATE MACHINE: If student is ALREADY INSIDE, reject duplicate ENTRY
    const lastMovement = await dbGet(`
      SELECT log_type FROM gate_entry_exit_logs 
      WHERE (student_id = ? OR roll_number = ?) AND face_matched = 1 
      ORDER BY id DESC LIMIT 1
    `, [student.student_id, student.roll_number]);

    if (lastMovement && lastMovement.log_type === 'ENTRY') {
      return res.json({
        success: false,
        already_inside: true,
        current_state: 'INSIDE',
        student: {
          student_id: student.student_id,
          name: student.name,
          roll_number: student.roll_number,
          branch: student.branch,
          hostel: currentHostel,
          room: currentRoom
        },
        message: `ℹ️ ${student.name} is ALREADY INSIDE Hostel. Next allowed gate movement is Exit (Camera 2).`
      });
    }

    // 6. DUPLICATE SCAN PROTECTION (15s debounce per student after validating state)
    const debounceKey = `ENTRY_${sId}`;
    if (gateDebounceMap.has(debounceKey) && (Date.now() - gateDebounceMap.get(debounceKey) < 15000)) {
      return res.json({
        success: false,
        debounced: true,
        already_inside: true,
        current_state: 'INSIDE',
        message: `ℹ️ Entry scan already recorded for ${student.name}. Next movement is Exit.`
      });
    }
    gateDebounceMap.set(debounceKey, Date.now());

    // Multi-Tier Time-Based Curfew Rules Engine (7 PM Curfew, 8 PM Final Alert, 10 PM Lockdown)
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const totalMinutes = hours * 60 + minutes;
    
    const curfewMins = 19 * 60; // 7:00 PM
    const finalAlertMins = 20 * 60; // 8:00 PM
    const lockdownMins = 22 * 60; // 10:00 PM

    let alertType = 'NONE';
    let alertMsg = 'On Time Entry';
    let isLate = 0;
    let lateMins = 0;

    if (totalMinutes > lockdownMins) {
      lateMins = totalMinutes - curfewMins;
      alertType = 'CRITICAL';
      isLate = 1;
      alertMsg = `CRITICAL Lockdown Entry past 10 PM (${Math.floor(lateMins / 60)}h ${lateMins % 60}m late)`;
    } else if (totalMinutes > finalAlertMins) {
      lateMins = totalMinutes - curfewMins;
      alertType = 'VERY_LATE';
      isLate = 1;
      alertMsg = `VERY LATE Entry past 8 PM (${Math.floor(lateMins / 60)}h ${lateMins % 60}m late)`;
    } else if (totalMinutes > curfewMins) {
      lateMins = totalMinutes - curfewMins;
      alertType = 'LATE_ENTRY';
      isLate = 1;
      alertMsg = `Late Entry by ${Math.floor(lateMins / 60)}h ${lateMins % 60}m`;
    }

    if (isLate) {
      await dbRun(
        `INSERT INTO security_alerts (alert_type, camera_id, gate_name, photo_url, student_id, notes) VALUES (?, ?, ?, ?, ?, ?)`,
        [alertType, camId, gate, photoPath, student.student_id, `${student.name} (${student.roll_number}) entered late: ${alertMsg} [Hostel: ${currentHostel} Room: ${currentRoom}]`]
      );
    }

    // 6. SYNCHRONIZE CANONICAL GATE PASS IN MYSQL (update existing or create biometric pass)
    if (mysqlPool && student.student_master_id) {
      try {
        const [openPasses] = await mysqlPool.query(
          "SELECT id, status, pass_number FROM gate_passes WHERE (student_id = ? OR student_id = ?) AND status = 'CHECKED_OUT' ORDER BY id DESC LIMIT 1",
          [student.student_master_id, student.student_id]
        );
        if (openPasses.length > 0) {
          const p = openPasses[0];
          await mysqlPool.query(
            "UPDATE gate_passes SET status = 'RETURNED', actual_in_time = NOW(), security_remarks = 'Automated AI Face Dual-Camera Terminal Scan' WHERE id = ?",
            [p.id]
          );
        } else {
          const passNum = 'BIO-IN-' + Date.now().toString().slice(-6);
          await mysqlPool.query(`
            INSERT INTO gate_passes (
              pass_number, student_id, hostel_id, pass_type, out_date_time, expected_in_date_time,
              actual_out_time, actual_in_time, reason, destination, status, security_remarks, created_at, updated_at
            ) VALUES (
              ?, ?, ?, 'LOCAL_OUTING', NOW(), NOW(),
              NOW(), NOW(), 'Automated Biometric Dual-Camera Gate Entry', 'Hostel In-Premises', 'RETURNED', 'AI Facial Recognition Camera Scan', NOW(), NOW()
            )
          `, [passNum, student.student_master_id, student.hostel_id || 1]);
        }
      } catch (gpErr) {
        console.warn('MySQL gate pass entry sync notice:', gpErr.message);
      }
    }

    // 7. RECORD CANONICAL ENTRY LOG IN GATE ACTIVITY TABLE
    const currentIsoTime = new Date().toISOString();
    const logResult = await dbRun(
      `INSERT INTO gate_entry_exit_logs (student_id, roll_number, log_type, camera_id, gate_name, log_time, face_matched, face_confidence, anti_spoof_passed, alert_type, photo_url, notes, late_minutes, is_late, is_missing, parent_notified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [student.student_id, student.roll_number, 'ENTRY', camId, gate, currentIsoTime, 1, conf, 1, alertType, photoPath, `${alertMsg} | ${currentHostel} Room ${currentRoom}`, lateMins, isLate, 0, 1]
    );

    // Sync to MySQL gate_entry_exit_logs table
    if (mysqlPool) {
      try {
        await mysqlPool.query(`
          INSERT INTO gate_entry_exit_logs 
          (student_id, roll_number, log_type, camera_id, gate_name, log_time, face_matched, face_confidence, anti_spoof_passed, alert_type, photo_url, notes, late_minutes, is_late, is_missing, parent_notified)
          VALUES (?, ?, 'ENTRY', ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
        `, [student.student_id, student.roll_number || student.student_id, camId, gate, 1, conf, 1, alertType, photoPath, `${alertMsg} | ${currentHostel} Room ${currentRoom}`, lateMins, isLate ? 1 : 0]);
      } catch (mErr) {
        console.warn('MySQL gate_entry_exit_logs entry sync notice:', mErr.message);
      }
    }

    // 8. LOG CANONICAL ACTIVITY TO MYSQL ACTIVITY_LOG TABLE
    if (mysqlPool && student.student_master_id) {
      try {
        await mysqlPool.query(`
          INSERT INTO activity_log (actor_id, action, module, entity_type, entity_id, description, metadata, created_at)
          VALUES (?, 'BIOMETRIC_ENTRY', 'GATE_PASS', 'STUDENT', ?, ?, ?, NOW())
        `, [
          student.student_master_id,
          student.student_master_id,
          `${student.name} (${student.roll_number}) entered hostel gate via AI Face Recognition (${currentHostel} Room ${currentRoom})`,
          JSON.stringify({ camera: gate, confidence: conf, isLate, room: currentRoom, hostel: currentHostel })
        ]);
      } catch (actErr) {
        console.warn('MySQL activity_log entry notice:', actErr.message);
      }
    }

    // Mark daily attendance if needed
    const dateStr = now.toISOString().split('T')[0];
    const existingAtt = await dbGet('SELECT * FROM attendance WHERE student_id = ? AND date = ?', [student.student_id, dateStr]);
    if (!existingAtt) {
      await dbRun(
        `INSERT INTO attendance (student_id, date, time, timestamp, status, mode, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [student.student_id, dateStr, now.toLocaleTimeString(), now.getTime(), isLate ? 'Late' : 'Present', 'Hostel Gate Camera 1', conf]
      );
    }

    res.json({
      success: true,
      log_id: logResult.id,
      student: {
        student_id: student.student_id,
        name: student.name,
        roll_number: student.roll_number,
        branch: student.branch,
        hostel: currentHostel,
        room: currentRoom
      },
      log_type: 'ENTRY',
      alert_type: alertType,
      is_late: isLate,
      late_minutes: lateMins,
      time: now.toLocaleTimeString(),
      message: `🚪 Entry Logged: ${student.name} (${alertMsg}) — ${currentHostel} Room ${currentRoom}`
    });
  } catch (err) {
    console.error('Error in /api/gate/entry:', err);
    res.status(500).json({ success: false, message: 'Gate entry processing error' });
  }
});

// POST /api/gate/exit - Process Camera 2 (EXIT)
router.post('/exit', async (req, res) => {
  try {
    const { student_id, studentId, confidence, anti_spoof_passed, snapshot_base64, gate_name } = req.body;
    const sId = (studentId || student_id || '').toString().trim();
    const conf = confidence || 95.0;
    const gate = gate_name || 'Hostel Gate 2 (Exit)';
    const camId = 'CAMERA_2_EXIT';

    let photoPath = '';
    if (snapshot_base64) {
      const base64Data = snapshot_base64.replace(/^data:image\/\w+;base64,/, '');
      const fileName = `exit_${sId || 'unknown'}_${Date.now()}.jpg`;
      const relativePath = path.join('uploads', 'gate_logs', fileName).replace(/\\/g, '/');
      const fullPath = path.join(__dirname, '..', relativePath);
      fs.writeFileSync(fullPath, base64Data, { encoding: 'base64' });
      photoPath = '/' + relativePath;
    }

    // 1. UNKNOWN PERSON / NO MATCH: Security alert only, NO exit event
    if (!sId || sId === 'UNKNOWN') {
      await dbRun(
        `INSERT INTO security_alerts (alert_type, camera_id, gate_name, photo_url, notes) VALUES (?, ?, ?, ?, ?)`,
        ['UNKNOWN', camId, gate, photoPath, 'Unrecognized person at exit gate']
      );

      await dbRun(
        `INSERT INTO gate_entry_exit_logs (student_id, log_type, camera_id, gate_name, face_matched, alert_type, photo_url, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['UNKNOWN', 'EXIT', camId, gate, 0, 'UNKNOWN', photoPath, 'Unknown person at Exit camera - Gate access denied']
      );

      return res.json({
        success: false,
        alert: 'UNKNOWN',
        message: '🚨 Unknown person detected leaving Gate! Security alert logged.'
      });
    }

    // 2. ANTI-SPOOF / LIVENESS FAILURE: Alert only, NO exit event
    if (anti_spoof_passed === false || anti_spoof_passed === 0) {
      await dbRun(
        `INSERT INTO security_alerts (alert_type, camera_id, gate_name, photo_url, student_id, notes) VALUES (?, ?, ?, ?, ?, ?)`,
        ['SPOOF_FAILED', camId, gate, photoPath, sId, `Liveness / anti-spoof check failed at Exit camera for ID: ${sId}`]
      );
      return res.status(403).json({
        success: false,
        alert: 'SPOOF_FAILED',
        message: '🚨 Anti-spoofing check failed! Photo/screen detected. Gate exit denied.'
      });
    }

    // 3. FETCH AUTHORITATIVE STUDENT & CURRENT HOSTEL ALLOCATION FROM MYSQL
    const student = await getAuthoritativeStudent(sId);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student record not found in system.' });
    }

    const currentHostel = student.hostel_name || 'Main Hostel';
    const currentRoom = student.room_number ? `${student.room_number}${student.bed_number ? ' (' + student.bed_number + ')' : ''}` : 'N/A';

    // 4. VALIDATE THAT STUDENT IS VALIDLY REGISTERED IN FACE SYSTEM
    const faceCountRow = await dbGet('SELECT COUNT(*) as cnt FROM face_embeddings WHERE student_id = ?', [student.student_id]);
    const sfdRow = await dbGet('SELECT status FROM student_face_data WHERE student_id = ? OR roll_number = ?', [student.student_id, student.roll_number]);
    const isRegistered = (faceCountRow && faceCountRow.cnt > 0) && (!sfdRow || sfdRow.status !== 'FAILED');

    if (!isRegistered) {
      await dbRun(
        `INSERT INTO security_alerts (alert_type, camera_id, gate_name, photo_url, student_id, notes) VALUES (?, ?, ?, ?, ?, ?)`,
        ['UNREGISTERED_STUDENT', camId, gate, photoPath, student.student_id, `${student.name} (${student.roll_number}) face registration is PENDING`]
      );
      return res.status(403).json({
        success: false,
        alert: 'PENDING',
        message: `Face registration pending for ${student.name}. Gate exit not permitted.`
      });
    }

    // 5. GATE STATE MACHINE: If student is ALREADY OUTSIDE, reject duplicate EXIT
    const lastMovement = await dbGet(`
      SELECT log_type FROM gate_entry_exit_logs 
      WHERE (student_id = ? OR roll_number = ?) AND face_matched = 1 
      ORDER BY id DESC LIMIT 1
    `, [student.student_id, student.roll_number]);

    if (lastMovement && lastMovement.log_type === 'EXIT') {
      return res.json({
        success: false,
        already_outside: true,
        current_state: 'OUTSIDE',
        student: {
          student_id: student.student_id,
          name: student.name,
          roll_number: student.roll_number,
          branch: student.branch,
          hostel: currentHostel,
          room: currentRoom
        },
        message: `ℹ️ ${student.name} is ALREADY OUTSIDE Hostel. Next allowed gate movement is Entry (Camera 1).`
      });
    }

    // 6. DUPLICATE SCAN PROTECTION (15s debounce per student after validating state)
    const debounceKey = `EXIT_${sId}`;
    if (gateDebounceMap.has(debounceKey) && (Date.now() - gateDebounceMap.get(debounceKey) < 15000)) {
      return res.json({
        success: false,
        debounced: true,
        already_outside: true,
        current_state: 'OUTSIDE',
        message: `ℹ️ Exit scan already recorded for ${student.name}. Next movement is Entry.`
      });
    }
    gateDebounceMap.set(debounceKey, Date.now());

    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const totalMinutes = hours * 60 + minutes;
    const normalExitMins = 16 * 60; // 4:00 PM

    let alertType = 'NONE';
    let alertMsg = 'Normal Hostel Exit';

    if (totalMinutes < normalExitMins) {
      alertType = 'EARLY_EXIT';
      alertMsg = 'Early Exit before 4:00 PM (Check Gate Pass)';
    }

    // 6. SYNCHRONIZE CANONICAL GATE PASS IN MYSQL (update approved pass or record biometric exit pass)
    if (mysqlPool && student.student_master_id) {
      try {
        const [openPasses] = await mysqlPool.query(
          "SELECT id, status, pass_number FROM gate_passes WHERE (student_id = ? OR student_id = ?) AND status = 'APPROVED' ORDER BY id DESC LIMIT 1",
          [student.student_master_id, student.student_id]
        );
        if (openPasses.length > 0) {
          const p = openPasses[0];
          await mysqlPool.query(
            "UPDATE gate_passes SET status = 'CHECKED_OUT', actual_out_time = NOW(), security_remarks = 'Automated AI Face Dual-Camera Terminal Scan' WHERE id = ?",
            [p.id]
          );
        } else {
          const passNum = 'BIO-OUT-' + Date.now().toString().slice(-6);
          await mysqlPool.query(`
            INSERT INTO gate_passes (
              pass_number, student_id, hostel_id, pass_type, out_date_time, expected_in_date_time,
              actual_out_time, reason, destination, status, security_remarks, created_at, updated_at
            ) VALUES (
              ?, ?, ?, 'LOCAL_OUTING', NOW(), DATE_ADD(NOW(), INTERVAL 4 HOUR),
              NOW(), 'Automated Biometric Dual-Camera Gate Exit', 'Campus Perimeter', 'CHECKED_OUT', 'AI Facial Recognition Camera Scan', NOW(), NOW()
            )
          `, [passNum, student.student_master_id, student.hostel_id || 1]);
        }
      } catch (gpErr) {
        console.warn('MySQL gate pass exit sync notice:', gpErr.message);
      }
    }

    // 7. RECORD CANONICAL EXIT LOG IN GATE ACTIVITY TABLE
    const currentIsoTime = new Date().toISOString();
    const logResult = await dbRun(
      `INSERT INTO gate_entry_exit_logs (student_id, roll_number, log_type, camera_id, gate_name, log_time, face_matched, face_confidence, anti_spoof_passed, alert_type, photo_url, notes, parent_notified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [student.student_id, student.roll_number, 'EXIT', camId, gate, currentIsoTime, 1, conf, 1, alertType, photoPath, `${alertMsg} | ${currentHostel} Room ${currentRoom}`, 1]
    );

    // Sync to MySQL gate_entry_exit_logs table
    if (mysqlPool) {
      try {
        await mysqlPool.query(`
          INSERT INTO gate_entry_exit_logs 
          (student_id, roll_number, log_type, camera_id, gate_name, log_time, face_matched, face_confidence, anti_spoof_passed, alert_type, photo_url, notes, late_minutes, is_late, is_missing, parent_notified)
          VALUES (?, ?, 'EXIT', ?, ?, NOW(), ?, ?, ?, ?, ?, ?, 0, 0, 0, 1)
        `, [student.student_id, student.roll_number || student.student_id, camId, gate, 1, conf, 1, alertType, photoPath, `${alertMsg} | ${currentHostel} Room ${currentRoom}`]);
      } catch (mErr) {
        console.warn('MySQL gate_entry_exit_logs exit sync notice:', mErr.message);
      }
    }

    // 8. LOG CANONICAL ACTIVITY TO MYSQL ACTIVITY_LOG TABLE
    if (mysqlPool && student.student_master_id) {
      try {
        await mysqlPool.query(`
          INSERT INTO activity_log (actor_id, action, module, entity_type, entity_id, description, metadata, created_at)
          VALUES (?, 'BIOMETRIC_EXIT', 'GATE_PASS', 'STUDENT', ?, ?, ?, NOW())
        `, [
          student.student_master_id,
          student.student_master_id,
          `${student.name} (${student.roll_number}) exited hostel gate via AI Face Recognition (${currentHostel} Room ${currentRoom})`,
          JSON.stringify({ camera: gate, confidence: conf, room: currentRoom, hostel: currentHostel })
        ]);
      } catch (actErr) {
        console.warn('MySQL activity_log exit notice:', actErr.message);
      }
    }

    res.json({
      success: true,
      log_id: logResult.id,
      student: {
        student_id: student.student_id,
        name: student.name,
        roll_number: student.roll_number,
        branch: student.branch,
        hostel: currentHostel,
        room: currentRoom
      },
      log_type: 'EXIT',
      time: now.toLocaleTimeString(),
      message: `🚪 Exit Logged: ${student.name} — ${currentHostel} Room ${currentRoom}`
    });
  } catch (err) {
    console.error('Error in /api/gate/exit:', err);
    res.status(500).json({ success: false, message: 'Gate exit processing error' });
  }
});

// GET /api/gate/logs - Get recent gate logs (strictly joined on student_id to prevent duplicate roll number rows)
router.get('/logs', async (req, res) => {
  try {
    const logs = await dbQuery(`
      SELECT g.*, 
             COALESCE(s.name, g.student_id) as name,
             s.name as student_name, 
             s.branch, 
             s.mobile 
      FROM gate_entry_exit_logs g 
      LEFT JOIN students s ON g.student_id = s.student_id 
      ORDER BY g.id DESC LIMIT 50
    `);
    res.json({ success: true, count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to retrieve gate logs' });
  }
});

// GET /api/gate/live - Current IN/OUT hostel status summary
router.get('/live', async (req, res) => {
  try {
    const totalStudents = await dbGet('SELECT COUNT(*) as count FROM students');
    const logs = await dbQuery(`
      SELECT student_id, log_type, log_time 
      FROM gate_entry_exit_logs 
      WHERE id IN (SELECT MAX(id) FROM gate_entry_exit_logs WHERE student_id IS NOT 'UNKNOWN' GROUP BY student_id)
    `);

    let insideCount = 0;
    let outsideCount = 0;
    const studentStates = {};

    logs.forEach(l => {
      studentStates[l.student_id] = l.log_type;
      if (l.log_type === 'ENTRY') insideCount++;
      else if (l.log_type === 'EXIT') outsideCount++;
    });

    const unknownLogs = await dbGet(`SELECT COUNT(*) as count FROM gate_entry_exit_logs WHERE alert_type = 'UNKNOWN' AND date(log_time) = date('now')`);
    const lateLogs = await dbGet(`SELECT COUNT(*) as count FROM gate_entry_exit_logs WHERE alert_type = 'LATE_ENTRY' AND date(log_time) = date('now')`);

    res.json({
      success: true,
      live: {
        presentInsideHostel: insideCount,
        currentlyOutside: (totalStudents ? totalStudents.count - insideCount : 0),
        lateEntriesToday: lateLogs ? lateLogs.count : 0,
        unacknowledgedAlerts: unknownLogs ? unknownLogs.count : 0
      },
      stats: {
        totalStudents: totalStudents ? totalStudents.count : 0,
        insideHostel: insideCount,
        outsideHostel: (totalStudents ? totalStudents.count - insideCount : 0),
        lateEntriesToday: lateLogs ? lateLogs.count : 0,
        unknownAlertsToday: unknownLogs ? unknownLogs.count : 0
      },
      student_states: studentStates
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to retrieve live gate status' });
  }
});

// POST /api/gate/register-student-30frames - Register Existing Student with 30-Frame Face Embeddings
router.post('/register-student-30frames', async (req, res) => {
  try {
    const {
      student_id,
      studentId,
      name,
      roll_number,
      rollNumber,
      branch,
      dob,
      academic_year,
      mobile,
      descriptors,
      photo_base64
    } = req.body;

    const sId = (studentId || student_id || '').toString().trim();
    const rNum = (rollNumber || roll_number || '').toString().trim();

    if (!sId && !rNum) {
      return res.status(400).json({ success: false, message: 'Existing Student ID or Roll Number is required for face registration.' });
    }

    // 1. Resolve student against Authoritative MySQL Master
    let targetStudentId = sId || rNum;
    let targetRoll = rNum || sId;
    let targetName = name || 'Student';
    let targetBranch = branch || 'General';
    let studentMasterId = null;

    if (mysqlPool) {
      const [mRows] = await mysqlPool.query(`
        SELECT s.id as student_master_id, COALESCE(s.student_id, CONCAT('STU-', s.id)) as student_id, s.roll_number, s.full_name as name, s.branch, s.photo_url
        FROM students s
        WHERE (s.student_id = ? OR s.roll_number = ? OR s.id = ?)
        LIMIT 1
      `, [sId, rNum, sId]);
      if (mRows.length > 0) {
        const s = mRows[0];
        targetStudentId = s.student_id;
        targetRoll = s.roll_number;
        targetName = s.name;
        targetBranch = s.branch;
        studentMasterId = s.student_master_id;
      }
    }

    // 2. Save photo snapshot if present
    let photoUrl = '';
    if (photo_base64) {
      const base64Data = photo_base64.replace(/^data:image\/\w+;base64,/, '');
      const safeId = targetStudentId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `student_${safeId}.jpg`;
      const relativePath = path.join('uploads', 'gate_logs', fileName).replace(/\\/g, '/');
      const fullPath = path.join(__dirname, '..', relativePath);
      fs.writeFileSync(fullPath, base64Data, { encoding: 'base64' });
      photoUrl = '/' + relativePath;
    }

    // 3. Delete previous embeddings to maintain clean state
    await dbRun('DELETE FROM face_embeddings WHERE student_id = ?', [targetStudentId]);
    await dbRun('DELETE FROM student_face_data WHERE student_id = ? OR roll_number = ?', [targetStudentId, targetRoll]);

    // 4. Save up to 30 face descriptors
    let descriptorAvg = null;
    if (descriptors && Array.isArray(descriptors) && descriptors.length > 0) {
      for (const desc of descriptors) {
        await dbRun(`
          INSERT INTO face_embeddings (student_id, descriptor_json, image_path)
          VALUES (?, ?, ?)
        `, [targetStudentId, JSON.stringify(desc), photoUrl]);
      }
      descriptorAvg = descriptors[0];
    } else {
      return res.status(400).json({ success: false, message: 'Valid face descriptors must be captured before registering.' });
    }

    // 5. Save multi-pose face data with status = 'REGISTERED'
    await dbRun(`
      INSERT INTO student_face_data (
        student_id, roll_number, face_embedding, photo_url, status
      ) VALUES (?, ?, ?, ?, 'REGISTERED')
    `, [
      targetStudentId, targetRoll, JSON.stringify(descriptorAvg || []), photoUrl
    ]);

    // 6. Update local SQLite mirror table with face_enrolled = 1
    const localStudent = await dbGet('SELECT * FROM students WHERE student_id = ? OR roll_number = ?', [targetStudentId, targetRoll]);
    if (localStudent) {
      await dbRun('UPDATE students SET face_enrolled = 1, photo_path = COALESCE(NULLIF(?, ""), photo_path) WHERE id = ?', [photoUrl, localStudent.id]);
    } else {
      await dbRun(`
        INSERT INTO students (student_id, name, roll_number, branch, department, photo_path, face_enrolled)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `, [targetStudentId, targetName, targetRoll, targetBranch, targetBranch, photoUrl]);
    }

    // 7. Update MySQL photo_url if absent
    if (mysqlPool && studentMasterId && photoUrl) {
      try {
        await mysqlPool.query('UPDATE students SET photo_url = COALESCE(NULLIF(photo_url, ""), ?) WHERE id = ?', [photoUrl, studentMasterId]);
      } catch (mErr) {}
    }

    // 8. Initial Desk Entry Log
    await dbRun(`
      INSERT INTO gate_entry_exit_logs (student_id, roll_number, log_type, camera_id, gate_name, face_matched, alert_type, notes)
      VALUES (?, ?, 'ENTRY', 'REGISTRATION_DESK', 'Hostel Desk', 1, 'NONE', 'Registered with 30-Frame Face Scanner')
    `, [targetStudentId, targetRoll]);

    res.json({
      success: true,
      student_id: targetStudentId,
      status: 'REGISTERED',
      message: `🎉 Face recognition registered successfully for ${targetName}! Face Status is now REGISTERED.`
    });
  } catch (err) {
    console.error('Error in register-student-30frames:', err);
    res.status(500).json({ success: false, message: 'Failed to register student: ' + err.message });
  }
});

// DELETE /api/gate/logs/:id - Delete single gate log entry
router.delete('/logs/:id', async (req, res) => {
  try {
    const logId = req.params.id;
    await dbRun('DELETE FROM gate_entry_exit_logs WHERE id = ?', [logId]);
    res.json({ success: true, message: 'Gate log entry deleted successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete gate log' });
  }
});

// DELETE /api/gate/logs-all - Bulk clear all gate movement logs
router.delete('/logs-all', async (req, res) => {
  try {
    await dbRun('DELETE FROM gate_entry_exit_logs');
    res.json({ success: true, message: 'All gate movement activity logs cleared cleanly.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to clear gate logs' });
  }
});

// =========================================================================
// DAILY CSV ARCHIVING & AUTOMATIC 1-DAY LOG DATA CLEANUP ENGINE
// =========================================================================

const DAILY_CSV_DIR = path.join(__dirname, '..', 'uploads', 'daily_csv_logs');
if (!fs.existsSync(DAILY_CSV_DIR)) {
  fs.mkdirSync(DAILY_CSV_DIR, { recursive: true });
}

// Helper to escape values for CSV output
function escapeCsvField(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

// Core Archiver & 1-Day Log Purge Engine
async function archiveAndCleanupOldLogs(forceAll = false) {
  try {
    let sqlCondition = "datetime(g.created_at) < datetime('now', '-1 day') OR datetime(g.log_time) < datetime('now', '-1 day')";
    let attCondition = "datetime(created_at) < datetime('now', '-1 day') OR date(date) < date('now', '-1 day')";
    
    if (forceAll) {
      sqlCondition = "1=1";
      attCondition = "1=1";
    }

    const oldGateLogs = await dbQuery(`
      SELECT g.*, 
             COALESCE(s.name, 'Student (' || COALESCE(g.roll_number, g.student_id) || ')') as student_name,
             s.branch, 
             s.mobile 
      FROM gate_entry_exit_logs g 
      LEFT JOIN students s ON (g.student_id = s.student_id OR g.roll_number = s.roll_number OR g.student_id = s.roll_number) 
      WHERE ${sqlCondition}
      ORDER BY g.id ASC
    `);

    if (!oldGateLogs || oldGateLogs.length === 0) {
      return {
        success: true,
        archivedCount: 0,
        message: 'No logs older than 1 day were found to archive.'
      };
    }

    // Group logs by date (YYYY-MM-DD)
    const logsByDate = {};
    oldGateLogs.forEach(log => {
      let dateKey = '';
      if (log.log_time && log.log_time.includes('T')) {
        dateKey = log.log_time.split('T')[0];
      } else if (log.log_time && log.log_time.includes(' ')) {
        dateKey = log.log_time.split(' ')[0];
      } else if (log.created_at) {
        dateKey = String(log.created_at).split('T')[0].split(' ')[0];
      } else {
        dateKey = new Date().toISOString().split('T')[0];
      }

      if (!logsByDate[dateKey]) logsByDate[dateKey] = [];
      logsByDate[dateKey].push(log);
    });

    let totalArchived = 0;
    const filesGenerated = [];

    for (const [dateStr, logs] of Object.entries(logsByDate)) {
      const fileName = `gate_logs_${dateStr}.csv`;
      const filePath = path.join(DAILY_CSV_DIR, fileName);
      const csvHeader = `"Log ID","Timestamp","Movement Type","Student ID","Roll Number","Student Name","Branch / Dept","Gate Name","Camera ID","Face Confidence (%)","Alert Status","Notes"\n`;
      const fileExisted = fs.existsSync(filePath);

      const rowsContent = logs.map(l => [
        escapeCsvField(l.id),
        escapeCsvField(l.log_time || l.created_at),
        escapeCsvField(l.log_type),
        escapeCsvField(l.student_id),
        escapeCsvField(l.roll_number),
        escapeCsvField(l.student_name),
        escapeCsvField(l.branch || 'General'),
        escapeCsvField(l.gate_name || 'Main Gate'),
        escapeCsvField(l.camera_id),
        escapeCsvField(l.face_confidence || '95.0'),
        escapeCsvField(l.alert_type || 'NONE'),
        escapeCsvField(l.notes || '')
      ].join(',')).join('\n') + '\n';

      if (!fileExisted) {
        fs.writeFileSync(filePath, csvHeader + rowsContent, 'utf8');
      } else {
        fs.appendFileSync(filePath, rowsContent, 'utf8');
      }

      totalArchived += logs.length;
      filesGenerated.push(fileName);
    }

    // Delete archived logs from active gate_entry_exit_logs table
    if (forceAll) {
      await dbRun("DELETE FROM gate_entry_exit_logs");
      await dbRun("DELETE FROM attendance");
    } else {
      await dbRun("DELETE FROM gate_entry_exit_logs WHERE datetime(created_at) < datetime('now', '-1 day') OR datetime(log_time) < datetime('now', '-1 day')");
      await dbRun(`DELETE FROM attendance WHERE ${attCondition}`);
    }

    console.log(`[Automated CSV Archiver] Saved ${totalArchived} logs into CSV archives (${filesGenerated.join(', ')}) and cleaned 1-day old DB entries.`);

    return {
      success: true,
      archivedCount: totalArchived,
      files: filesGenerated,
      message: `Successfully generated ${filesGenerated.length} daily CSV archive(s) and cleared database logs older than 1 day.`
    };
  } catch (err) {
    console.error('[CSV Archiver Error]:', err);
    return { success: false, message: 'Archive failed: ' + err.message };
  }
}

// POST /api/gate/trigger-archive - Manual trigger for Admin
router.post('/trigger-archive', async (req, res) => {
  try {
    const { forceAll } = req.body || {};
    const result = await archiveAndCleanupOldLogs(forceAll === true);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to execute CSV archive & cleanup' });
  }
});

// GET /api/gate/csv-archives - List all available daily CSV log files
router.get('/csv-archives', (req, res) => {
  try {
    if (!fs.existsSync(DAILY_CSV_DIR)) {
      return res.json({ success: true, files: [] });
    }

    const fileNames = fs.readdirSync(DAILY_CSV_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
    const filesList = fileNames.map(fileName => {
      const filePath = path.join(DAILY_CSV_DIR, fileName);
      const stat = fs.statSync(filePath);
      
      // Calculate record count by line count
      let recordCount = 0;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.trim().split('\n').filter(l => l.trim().length > 0);
        recordCount = Math.max(0, lines.length - 1); // Exclude header line
      } catch (e) {}

      // Extract date from filename (gate_logs_2026-10-06.csv -> 2026-10-06)
      const dateMatch = fileName.match(/\d{4}-\d{2}-\d{2}/);
      const logDate = dateMatch ? dateMatch[0] : 'Unknown Date';

      return {
        filename: fileName,
        log_date: logDate,
        size_bytes: stat.size,
        size_kb: (stat.size / 1024).toFixed(2),
        record_count: recordCount,
        created_at: stat.birthtime || stat.mtime,
        download_url: `/api/gate/download-csv/${fileName}`
      };
    });

    // Sort by log date descending
    filesList.sort((a, b) => b.log_date.localeCompare(a.log_date));

    res.json({
      success: true,
      count: filesList.length,
      files: filesList
    });
  } catch (err) {
    console.error('Error fetching CSV archives:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve CSV archives list' });
  }
});

// GET /api/gate/download-csv/:filename - Download specific daily CSV file
router.get('/download-csv/:filename', (req, res) => {
  try {
    const fileName = req.params.filename;
    
    // Prevent directory traversal attacks
    if (!fileName || path.basename(fileName) !== fileName || !fileName.toLowerCase().endsWith('.csv')) {
      return res.status(400).send('Invalid filename request.');
    }

    const filePath = path.join(DAILY_CSV_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('Requested CSV log archive file was not found.');
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.sendFile(filePath);
  } catch (err) {
    console.error('CSV Download error:', err);
    res.status(500).send('Error serving CSV download');
  }
});

// Run background archiver on startup and every 30 minutes
setTimeout(() => {
  archiveAndCleanupOldLogs(false);
}, 5000);

setInterval(() => {
  archiveAndCleanupOldLogs(false);
}, 30 * 60 * 1000);

module.exports = router;

