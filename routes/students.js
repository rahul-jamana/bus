const express = require('express');
const router = express.Router();
const { dbQuery, dbGet, dbRun } = require('../db/database');
const fs = require('fs');
const path = require('path');

let StudentModel = null;
try {
  StudentModel = require('../models/Student');
} catch (e) {}

let mysqlPool = null;

// GET /api/students - List all students or filter by branch/semester/search
router.get('/', async (req, res) => {
  try {
    const { branch, department, semester, search } = req.query;
    const targetBranch = branch || department;

    if (process.env.MONGODB_URI) {
      const query = {};
      if (targetBranch && targetBranch !== 'All') {
        query.branch = targetBranch;
      }
      if (semester && semester !== 'All') {
        query.semester = semester;
      }
      if (search) {
        query.$or = [
          { name: new RegExp(search, 'i') },
          { rollNumber: new RegExp(search, 'i') },
          { registrationNumber: new RegExp(search, 'i') },
          { studentId: new RegExp(search, 'i') }
        ];
      }
      const students = await StudentModel.find(query).sort({ createdAt: -1 });
      return res.json({ success: true, count: students.length, students });
    }

    // SQLite Fallback
    let sql = 'SELECT * FROM students WHERE 1=1';
    let params = [];

    if (targetBranch && targetBranch !== 'All') {
      sql += ' AND (branch = ? OR department = ?)';
      params.push(targetBranch, targetBranch);
    }

    if (semester && semester !== 'All') {
      sql += ' AND semester = ?';
      params.push(semester);
    }

    if (search) {
      sql += ' AND (name LIKE ? OR student_id LIKE ? OR roll_number LIKE ? OR registration_number LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term, term);
    }

    sql += ' ORDER BY id DESC';
    const students = await dbQuery(sql, params);
    
    // Normalize fields for frontend
    const normalized = students.map(s => ({
      ...s,
      rollNumber: s.roll_number || s.rollNumber,
      registrationNumber: s.registration_number || s.registrationNumber,
      branch: s.branch || s.department,
      studentId: s.student_id || s.studentId,
      photoPath: s.photo_path || s.photoPath || ''
    }));

    res.json({ success: true, count: normalized.length, students: normalized });
  } catch (err) {
    console.error('Error fetching students:', err);
    res.status(500).json({ success: false, message: 'Database error fetching students' });
  }
});

// GET /api/students/hostel-face-status - Authoritative MySQL Hostel Student Master linked to Face Registration
router.get('/hostel-face-status', async (req, res) => {
  try {
    if (!mysqlPool) {
      return res.status(503).json({
        success: false,
        message: 'Authoritative MySQL Database connection unavailable. Cannot retrieve student master.'
      });
    }

    const { status, filter, search, hostel } = req.query;
    const targetFilter = (status || filter || 'ALL').toUpperCase();

    // 1. Fetch ALL ACTIVE Hostel Students from Authoritative MySQL Master
    const [students] = await mysqlPool.query(`
      SELECT 
        s.id as student_master_id,
        COALESCE(s.student_id, CONCAT('STU-', s.id)) as student_id,
        s.roll_number,
        s.full_name as name,
        s.branch,
        s.semester,
        s.section,
        s.phone,
        s.email,
        s.photo_url,
        sa.id as allocation_id,
        sa.status as allocation_status,
        h.id as hostel_id,
        h.name as hostel_name,
        h.code as hostel_code,
        r.id as room_id,
        r.room_number,
        b.id as bed_id,
        b.bed_number
      FROM student_allocations sa
      JOIN rooms r ON sa.room_id = r.id
      JOIN hostels h ON r.hostel_id = h.id
      LEFT JOIN beds b ON sa.bed_id = b.id
      JOIN students s ON (s.id = sa.student_id OR s.student_id = sa.student_id OR s.roll_number = sa.student_id)
      WHERE sa.status = 'ACTIVE'
      ORDER BY h.name ASC, r.room_number ASC
    `);

    // 2. Fetch Face Registration and Embedding Status from SQLite Face Engine
    const faceEmbeddings = await dbQuery(`
      SELECT student_id, COUNT(*) as embedding_count 
      FROM face_embeddings 
      GROUP BY student_id
    `);
    const faceMap = new Map();
    faceEmbeddings.forEach(f => {
      if (f.student_id) faceMap.set(String(f.student_id), f.embedding_count);
    });

    const faceDataRows = await dbQuery(`
      SELECT student_id, roll_number, status, photo_url 
      FROM student_face_data
    `);
    const faceStatusMap = new Map();
    const facePhotoMap = new Map();
    faceDataRows.forEach(f => {
      if (f.student_id) {
        faceStatusMap.set(String(f.student_id), f.status);
        if (f.photo_url) facePhotoMap.set(String(f.student_id), f.photo_url);
      }
      if (f.roll_number) {
        faceStatusMap.set(String(f.roll_number), f.status);
        if (f.photo_url) facePhotoMap.set(String(f.roll_number), f.photo_url);
      }
    });

    let counts = {
      total: students.length,
      registered: 0,
      pending: 0,
      failed: 0,
      recapture: 0
    };

    const resolvedStudents = [];

    for (const s of students) {
      const sId = String(s.student_id);
      const rNum = String(s.roll_number);
      const sMasterId = String(s.student_master_id);

      const embCount = (faceMap.get(sId) || 0) + (faceMap.get(rNum) || 0) + (faceMap.get(sMasterId) || 0);
      const recordedStatus = (faceStatusMap.get(sId) || faceStatusMap.get(rNum) || faceStatusMap.get(sMasterId) || '').toUpperCase();
      const facePhoto = facePhotoMap.get(sId) || facePhotoMap.get(rNum) || facePhotoMap.get(sMasterId) || s.photo_url || '';

      let faceStatus = 'PENDING';
      if (recordedStatus === 'FAILED') {
        faceStatus = 'FAILED';
        counts.failed++;
      } else if (recordedStatus === 'REQUIRES_RECAPTURE') {
        faceStatus = 'REQUIRES_RECAPTURE';
        counts.recapture++;
      } else if (embCount > 0 && recordedStatus !== 'FAILED') {
        faceStatus = 'REGISTERED';
        counts.registered++;
      } else {
        faceStatus = 'PENDING';
        counts.pending++;
      }

      // Safe metadata representation (NO RAW EMBEDDINGS)
      const studentItem = {
        student_id: s.student_id,
        student_master_id: s.student_master_id,
        roll_number: s.roll_number,
        name: s.name,
        branch: s.branch,
        semester: s.semester,
        section: s.section,
        phone: s.phone,
        email: s.email,
        hostel: s.hostel_name,
        hostel_name: s.hostel_name,
        hostel_id: s.hostel_id,
        room: s.room_number,
        room_number: s.room_number,
        bed: s.bed_number,
        bed_number: s.bed_number,
        photo_url: facePhoto,
        face_status: faceStatus,
        face_registered: faceStatus === 'REGISTERED',
        embedding_frames: embCount
      };

      // Filter check
      let matchesFilter = true;
      if (targetFilter === 'PENDING' && faceStatus !== 'PENDING') matchesFilter = false;
      if (targetFilter === 'REGISTERED' && faceStatus !== 'REGISTERED') matchesFilter = false;
      if (targetFilter === 'FAILED' && faceStatus !== 'FAILED') matchesFilter = false;
      if (targetFilter === 'RECAPTURE' && faceStatus !== 'REQUIRES_RECAPTURE') matchesFilter = false;

      // Search check
      if (matchesFilter && search) {
        const term = search.toLowerCase();
        const matchesTerm = (
          (s.name && s.name.toLowerCase().includes(term)) ||
          (s.roll_number && s.roll_number.toLowerCase().includes(term)) ||
          (s.student_id && s.student_id.toLowerCase().includes(term)) ||
          (s.room_number && s.room_number.toLowerCase().includes(term)) ||
          (s.hostel_name && s.hostel_name.toLowerCase().includes(term))
        );
        if (!matchesTerm) matchesFilter = false;
      }

      // Hostel filter check
      if (matchesFilter && hostel && hostel !== 'ALL') {
        if (s.hostel_name !== hostel && String(s.hostel_id) !== hostel) {
          matchesFilter = false;
        }
      }

      if (matchesFilter) {
        resolvedStudents.push(studentItem);
      }
    }

    res.json({
      success: true,
      counts,
      count: resolvedStudents.length,
      students: resolvedStudents
    });
  } catch (err) {
    console.error('Error fetching hostel face status:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve hostel face status: ' + err.message });
  }
});

// GET /api/students/:student_id - Get single student profile
router.get('/:student_id', async (req, res) => {
  try {
    const studentId = req.params.student_id;

    if (process.env.MONGODB_URI) {
      const student = await StudentModel.findOne({
        $or: [{ studentId }, { rollNumber: studentId }]
      });
      if (!student) {
        return res.status(404).json({ success: false, message: 'Student not found' });
      }
      return res.json({ success: true, student, face_samples: student.descriptors ? student.descriptors.length : 0 });
    }

    const student = await dbGet('SELECT * FROM students WHERE student_id = ? OR roll_number = ?', [studentId, studentId]);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    
    const embeddings = await dbQuery('SELECT id, created_at, image_path FROM face_embeddings WHERE student_id = ?', [student.student_id]);
    
    const normalized = {
      ...student,
      rollNumber: student.roll_number,
      registrationNumber: student.registration_number,
      branch: student.branch || student.department,
      studentId: student.student_id,
      photoPath: student.photo_path
    };

    res.json({ success: true, student: normalized, face_samples: embeddings.length, embeddings });
  } catch (err) {
    console.error('Error retrieving student:', err);
    res.status(500).json({ success: false, message: 'Error retrieving student profile' });
  }
});

// POST /api/students - Add new student with complete details
router.post('/', async (req, res) => {
  try {
    const { 
      name, 
      rollNumber, roll_number,
      registrationNumber, registration_number,
      branch, department,
      semester, 
      section, 
      mobile, phone,
      email, 
      address,
      parentName, parent_name,
      parentMobile, parent_mobile,
      parentWhatsapp, parent_whatsapp,
      parentEmail, parent_email,
      emergencyContact, emergency_contact
    } = req.body;

    const rNum = rollNumber || roll_number;
    const regNum = registrationNumber || registration_number;
    const bName = branch || department;
    const mobNum = mobile || phone;
    const pName = parentName || parent_name || '';
    const pMob = parentMobile || parent_mobile || mobNum || '';
    const pWhatsapp = parentWhatsapp || parent_whatsapp || pMob || '';
    const pEmail = parentEmail || parent_email || email || '';
    const eContact = emergencyContact || emergency_contact || pMob || '';
    const sId = req.body.studentId || req.body.student_id || `STU-${rNum || Date.now()}`;

    if (!name || !rNum || !bName) {
      return res.status(400).json({ 
        success: false, 
        message: 'Student Name, Roll Number, and Branch are required fields.' 
      });
    }

    if (process.env.MONGODB_URI) {
      const existing = await StudentModel.findOne({
        $or: [{ rollNumber: rNum }, { registrationNumber: regNum }, { studentId: sId }]
      });
      if (existing) {
        return res.status(400).json({ success: false, message: 'Student with this Roll Number or Registration Number already exists.' });
      }

      const newStudent = await StudentModel.create({
        studentId: sId,
        name,
        rollNumber: rNum,
        registrationNumber: regNum || `REG-${rNum}`,
        branch: bName,
        semester: semester || 'Semester 1',
        section: section || 'A',
        mobile: mobNum || '',
        email: email || '',
        address: address || '',
        parentName: pName,
        parentMobile: pMob,
        parentWhatsapp: pWhatsapp,
        parentEmail: pEmail,
        emergencyContact: eContact
      });

      return res.status(201).json({
        success: true,
        message: 'Student registered successfully!',
        student: newStudent
      });
    }

    // SQLite Fallback
    const existing = await dbGet('SELECT id FROM students WHERE student_id = ? OR roll_number = ?', [sId, rNum]);
    if (existing) {
      return res.status(400).json({ success: false, message: 'Student ID or Roll Number already exists.' });
    }

    const result = await dbRun(
      `INSERT INTO students (student_id, name, roll_number, registration_number, branch, department, semester, section, mobile, phone, email, address, parent_name, parent_mobile, parent_whatsapp, parent_email, emergency_contact, face_enrolled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [sId, name, rNum, regNum || `REG-${rNum}`, bName, bName, semester || 'Semester 1', section || 'A', mobNum || '', mobNum || '', email || '', address || '', pName, pMob, pWhatsapp, pEmail, eContact]
    );

    res.status(201).json({
      success: true,
      message: 'Student registered successfully!',
      student: { id: result.id, student_id: sId, studentId: sId, name, roll_number: rNum, rollNumber: rNum, branch: bName, parent_name: pName }
    });
  } catch (err) {
    console.error('Error adding student:', err);
    res.status(500).json({ success: false, message: 'Server error while adding student' });
  }
});

// PUT /api/students/:student_id - Update student information
router.put('/:student_id', async (req, res) => {
  try {
    const studentId = req.params.student_id;
    const { 
      name, 
      rollNumber, roll_number, 
      registrationNumber, registration_number, 
      branch, department, 
      semester, 
      section, 
      mobile, phone, 
      email, 
      address 
    } = req.body;

    const rNum = rollNumber || roll_number;
    const regNum = registrationNumber || registration_number;
    const bName = branch || department;
    const mobNum = mobile || phone;

    if (process.env.MONGODB_URI) {
      const student = await StudentModel.findOneAndUpdate(
        { $or: [{ studentId }, { rollNumber: studentId }] },
        {
          name,
          rollNumber: rNum,
          registrationNumber: regNum,
          branch: bName,
          semester,
          section,
          mobile: mobNum,
          email,
          address
        },
        { new: true }
      );
      if (!student) return res.status(404).json({ success: false, message: 'Student not found' });
      return res.json({ success: true, message: 'Student details updated successfully', student });
    }

    const existing = await dbGet('SELECT id FROM students WHERE student_id = ? OR roll_number = ?', [studentId, studentId]);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    await dbRun(
      `UPDATE students SET name = ?, roll_number = ?, registration_number = ?, branch = ?, department = ?, semester = ?, section = ?, mobile = ?, phone = ?, email = ?, address = ? WHERE id = ?`,
      [name, rNum, regNum, bName, bName, semester, section, mobNum, mobNum, email, address, existing.id]
    );

    res.json({ success: true, message: 'Student details updated successfully' });
  } catch (err) {
    console.error('Update student error:', err);
    res.status(500).json({ success: false, message: 'Failed to update student details' });
  }
});

// DELETE /api/students/:student_id - Delete student and their facial data across all tables
router.delete('/:student_id', async (req, res) => {
  try {
    const studentId = req.params.student_id;

    if (process.env.MONGODB_URI) {
      await StudentModel.deleteOne({ $or: [{ studentId }, { rollNumber: studentId }] });
      return res.json({ success: true, message: 'Student deleted successfully' });
    }

    const student = await dbGet('SELECT * FROM students WHERE student_id = ? OR roll_number = ?', [studentId, studentId]);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    // Delete photo directory if exists
    const studentFolder = path.join(__dirname, '..', 'uploads', 'faces', student.student_id);
    if (fs.existsSync(studentFolder)) {
      fs.rmSync(studentFolder, { recursive: true, force: true });
    }

    await dbRun('DELETE FROM students WHERE id = ?', [student.id]);
    await dbRun('DELETE FROM face_embeddings WHERE student_id = ? OR student_id = ?', [student.student_id, student.roll_number]);
    await dbRun('DELETE FROM student_face_data WHERE student_id = ? OR roll_number = ?', [student.student_id, student.roll_number]);
    await dbRun('DELETE FROM attendance WHERE student_id = ? OR student_id = ?', [student.student_id, student.roll_number]);
    await dbRun('DELETE FROM gate_entry_exit_logs WHERE student_id = ? OR roll_number = ?', [student.student_id, student.roll_number]);
    await dbRun('DELETE FROM security_alerts WHERE student_id = ? OR student_id = ?', [student.student_id, student.roll_number]);

    res.json({ success: true, message: `Student ${student.name} (${student.roll_number}) deleted successfully from all system tables!` });
  } catch (err) {
    console.error('Delete student error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete student: ' + err.message });
  }
});

// POST /api/students/bulk-delete - Delete multiple selected students
router.post('/bulk-delete', async (req, res) => {
  try {
    const { student_ids } = req.body;
    if (!Array.isArray(student_ids) || student_ids.length === 0) {
      return res.status(400).json({ success: false, message: 'No student IDs provided for deletion.' });
    }

    for (const sId of student_ids) {
      await dbRun('DELETE FROM students WHERE student_id = ? OR roll_number = ?', [sId, sId]);
      await dbRun('DELETE FROM face_embeddings WHERE student_id = ? OR student_id = ?', [sId, sId]);
      await dbRun('DELETE FROM student_face_data WHERE student_id = ? OR roll_number = ?', [sId, sId]);
      await dbRun('DELETE FROM attendance WHERE student_id = ? OR student_id = ?', [sId, sId]);
      await dbRun('DELETE FROM gate_entry_exit_logs WHERE student_id = ? OR roll_number = ?', [sId, sId]);
      await dbRun('DELETE FROM security_alerts WHERE student_id = ? OR student_id = ?', [sId, sId]);
    }

    res.json({ success: true, message: `Successfully deleted ${student_ids.length} student records and associated face data.` });
  } catch (err) {
    console.error('Bulk delete error:', err);
    res.status(500).json({ success: false, message: 'Failed to execute bulk deletion' });
  }
});

// DELETE /api/students/all/clear - Purge all student directory records
router.delete('/all/clear', async (req, res) => {
  try {
    await dbRun('DELETE FROM students');
    await dbRun('DELETE FROM face_embeddings');
    await dbRun('DELETE FROM student_face_data');
    res.json({ success: true, message: 'All student directory profiles and face embeddings deleted cleanly.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to clear all students' });
  }
});

// GET /api/students/:id/gate-logs - My Gate Log section for Student Profile
router.get('/:id/gate-logs', async (req, res) => {
  try {
    const sId = req.params.id;
    const student = await dbGet('SELECT * FROM students WHERE student_id = ? OR roll_number = ?', [sId, sId]);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student record not found' });
    }

    const today = new Date().toISOString().split('T')[0];
    
    // Query student's complete gate logs
    const logs = await dbQuery(`
      SELECT * FROM gate_entry_exit_logs 
      WHERE (student_id = ? OR roll_number = ? OR student_id = ?)
      ORDER BY id DESC LIMIT 100
    `, [student.student_id, student.roll_number, student.roll_number]);

    const todayEntries = logs.filter(l => l.log_type === 'ENTRY' && String(l.log_time).includes(today)).length;
    const todayExits = logs.filter(l => l.log_type === 'EXIT' && String(l.log_time).includes(today)).length;
    const totalLate = logs.filter(l => l.is_late === 1 || l.alert_type === 'LATE_ENTRY' || l.alert_type === 'VERY_LATE' || l.alert_type === 'CRITICAL').length;

    res.json({
      success: true,
      student: {
        student_id: student.student_id,
        name: student.name,
        roll_number: student.roll_number,
        branch: student.branch
      },
      summary: {
        todayEntries,
        todayExits,
        totalLateEntries: totalLate,
        totalLogs: logs.length
      },
      logs
    });
  } catch (err) {
    console.error('Error fetching student gate logs:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch student gate logs' });
  }
});

module.exports = router;

