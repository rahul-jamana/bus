const express = require('express');
const router = express.Router();
const { dbQuery, dbGet, dbRun } = require('../db/database');
const { dispatchParentNotifications } = require('./notifications');

let AttendanceModel = null;
let StudentModel = null;
try {
  AttendanceModel = require('../models/Attendance');
  StudentModel = require('../models/Student');
} catch (e) {}

// POST /api/attendance/mark - Automatically mark attendance with duplicate prevention & Parent Notifications
router.post('/mark', async (req, res) => {
  try {
    const { student_id, studentId, confidence, device, mode, location_lat, location_lng } = req.body;
    const targetStudentId = studentId || student_id;

    if (!targetStudentId) {
      return res.status(400).json({ success: false, message: 'Student ID is required' });
    }

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const currentTimestamp = now.getTime();

    // Determine status (Timing Schedule: 9:00 AM to 3:00 PM)
    // Before 9:00 AM => 'Early'
    // 9:00 AM or later => 'Late'
    const hour = now.getHours();
    const calculatedStatus = (hour < 9) ? 'Early' : 'Late';
    const reqStatus = req.body.status;
    const status = (reqStatus && ['Early', 'Late', 'Present', 'Absent'].includes(reqStatus)) ? reqStatus : calculatedStatus;

    // 1. MongoDB Execution Path
    if (process.env.MONGODB_URI) {
      const student = await StudentModel.findOne({
        $or: [{ studentId: targetStudentId }, { rollNumber: targetStudentId }]
      });

      if (!student) {
        return res.status(404).json({ success: false, message: 'Student not found in registry' });
      }

      // Check Duplicate Attendance for Today (Strict 1 attendance per student per day rule)
      const existingAttendance = await AttendanceModel.findOne({
        studentId: student.studentId,
        date: dateStr,
        status: { $in: ['Present', 'Late', 'Early'] }
      });

      if (existingAttendance) {
        return res.json({
          success: false,
          duplicate: true,
          message: `✅ Attendance already marked today at ${existingAttendance.time}`,
          student: {
            studentId: student.studentId,
            name: student.name,
            rollNumber: student.rollNumber,
            branch: student.branch,
            semester: student.semester
          }
        });
      }

      const newLog = await AttendanceModel.create({
        studentId: student.studentId,
        name: student.name,
        rollNumber: student.rollNumber,
        branch: student.branch,
        semester: student.semester,
        date: dateStr,
        time: timeStr,
        timestamp: currentTimestamp,
        status,
        device: device || 'Webcam',
        confidence: confidence || 98.5,
        locationLat: location_lat || null,
        locationLng: location_lng || null
      });

      // Dispatch Email, WhatsApp, SMS notifications to Parent
      const notificationResults = await dispatchParentNotifications(student, newLog);

      return res.json({
        success: true,
        duplicate: false,
        message: `Attendance Marked! ✔ ${student.name} (Roll ${student.rollNumber}) - ${status}`,
        attendance: newLog,
        notifications: notificationResults
      });
    }

    // 2. SQLite Execution Path
    const student = await dbGet(
      'SELECT * FROM students WHERE student_id = ? OR roll_number = ?',
      [targetStudentId, targetStudentId]
    );

    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found in registry' });
    }

    // Check duplicate attendance for today
    const existingLog = await dbGet(
      `SELECT * FROM attendance WHERE student_id = ? AND date = ? AND status IN ('Present', 'Late', 'Early') ORDER BY id DESC LIMIT 1`,
      [student.student_id, dateStr]
    );

    if (existingLog) {
      return res.json({
        success: false,
        duplicate: true,
        message: `✅ Attendance already marked today at ${existingLog.time}`,
        student: {
          studentId: student.student_id,
          student_id: student.student_id,
          name: student.name,
          rollNumber: student.roll_number,
          roll_number: student.roll_number,
          branch: student.branch || student.department,
          semester: student.semester || '1'
        }
      });
    }

    const result = await dbRun(
      `INSERT INTO attendance (student_id, date, time, timestamp, status, mode, location_lat, location_lng, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        student.student_id,
        dateStr,
        timeStr,
        currentTimestamp,
        status,
        device || mode || 'Webcam',
        location_lat || null,
        location_lng || null,
        confidence || 98.5
      ]
    );

    const attendanceObj = {
      id: result.id,
      studentId: student.student_id,
      student_id: student.student_id,
      name: student.name,
      rollNumber: student.roll_number,
      roll_number: student.roll_number,
      branch: student.branch || student.department,
      semester: student.semester || '1',
      date: dateStr,
      time: timeStr,
      status,
      device: device || mode || 'Webcam',
      confidence: confidence || 98.5
    };

    // Dispatch Email, WhatsApp, SMS notifications to Parent
    const notificationResults = await dispatchParentNotifications(student, attendanceObj);

    await dbRun(
      `INSERT INTO notifications (title, message, type) VALUES (?, ?, ?)`,
      ['Attendance Marked', `${student.name} (Roll ${student.roll_number}) marked ${status} at ${timeStr}`, 'success']
    );

    res.json({
      success: true,
      duplicate: false,
      message: `Attendance Marked! ✔ ${student.name} (Roll ${student.roll_number}) - ${status}`,
      attendance: attendanceObj,
      notifications: notificationResults
    });
  } catch (err) {
    console.error('Error marking attendance:', err);
    res.status(500).json({ success: false, message: 'Server error marking attendance' });
  }
});

// GET /api/attendance/history - Filtered attendance records with student details
router.get('/history', async (req, res) => {
  try {
    const { date, branch, department, semester, status, search } = req.query;
    const targetBranch = branch || department;

    if (process.env.MONGODB_URI) {
      const query = {};
      if (date) query.date = date;
      if (targetBranch && targetBranch !== 'All') query.branch = targetBranch;
      if (semester && semester !== 'All') query.semester = semester;
      if (status && status !== 'All') query.status = status;
      if (search) {
        query.$or = [
          { name: new RegExp(search, 'i') },
          { rollNumber: new RegExp(search, 'i') },
          { studentId: new RegExp(search, 'i') }
        ];
      }

      const logs = await AttendanceModel.find(query).sort({ timestamp: -1 });
      return res.json({ success: true, count: logs.length, logs });
    }

    // SQLite Fallback
    let sql = `
      SELECT a.*, 
             COALESCE(s.name, 'Student (' || a.student_id || ')') as name, 
             COALESCE(s.roll_number, a.student_id) as roll_number, 
             COALESCE(s.branch, s.department, 'Computer Science') as branch, 
             COALESCE(s.department, 'Computer Science') as department, 
             COALESCE(s.semester, 'Semester 1') as semester, 
             s.photo_path
      FROM attendance a
      LEFT JOIN students s ON (a.student_id = s.student_id OR a.student_id = s.roll_number)
      WHERE 1=1
    `;
    let params = [];

    if (date) {
      sql += ' AND a.date = ?';
      params.push(date);
    }

    if (targetBranch && targetBranch !== 'All') {
      sql += ' AND (s.branch = ? OR s.department = ? OR COALESCE(s.branch, s.department) = ?)';
      params.push(targetBranch, targetBranch, targetBranch);
    }

    if (semester && semester !== 'All') {
      sql += ' AND s.semester = ?';
      params.push(semester);
    }

    if (status && status !== 'All') {
      sql += ' AND a.status = ?';
      params.push(status);
    }

    if (search) {
      sql += ' AND (s.name LIKE ? OR s.roll_number LIKE ? OR a.student_id LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    sql += ' ORDER BY a.timestamp DESC';
    const rows = await dbQuery(sql, params);

    const normalizedLogs = rows.map(r => ({
      ...r,
      name: r.name || `Student (${r.student_id})`,
      rollNumber: r.roll_number || r.rollNumber || r.student_id,
      studentId: r.student_id || r.studentId,
      branch: r.branch || r.department || 'Computer Science',
      device: r.mode || 'Webcam'
    }));

    res.json({ success: true, count: normalizedLogs.length, logs: normalizedLogs });
  } catch (err) {
    console.error('Error fetching attendance history:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve attendance history' });
  }
});

module.exports = router;
