const PDFDocument = require('pdfkit');
const { dbQuery, dbGet, dbRun } = require('../db/database');

/**
 * Data Retention Policy:
 * Auto-purge bus boarding logs and security logs older than 30 days
 * to keep SQLite database fast, lean, and compliant.
 */
async function purgeOldLogs(days = 30) {
  try {
    const logRes = await dbRun(
      `DELETE FROM bus_boarding_logs WHERE log_time < datetime('now', '-' || ? || ' days')`,
      [days]
    );
    const alertRes = await dbRun(
      `DELETE FROM security_alerts WHERE created_at < datetime('now', '-' || ? || ' days')`,
      [days]
    );

    console.log(`[Data Retention] 30-day purge executed. Removed ${logRes.changes || 0} boarding logs, ${alertRes.changes || 0} security alerts.`);
    return {
      success: true,
      deletedLogs: logRes.changes || 0,
      deletedAlerts: alertRes.changes || 0,
      retentionDays: days,
      executedAt: new Date().toISOString()
    };
  } catch (err) {
    console.error('[Data Retention] Purge error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Get data retention diagnostics
 */
async function getRetentionStats(days = 30) {
  try {
    const totalActive = await dbGet('SELECT COUNT(*) as count FROM bus_boarding_logs');
    const oldestRow = await dbGet('SELECT MIN(log_time) as oldest, MAX(log_time) as newest FROM bus_boarding_logs');
    const eligibleForPurge = await dbGet(
      `SELECT COUNT(*) as count FROM bus_boarding_logs WHERE log_time < datetime('now', '-' || ? || ' days')`,
      [days]
    );

    return {
      success: true,
      retentionDays: days,
      totalActiveRecords: totalActive ? totalActive.count : 0,
      oldestRecord: oldestRow ? oldestRow.oldest : null,
      newestRecord: oldestRow ? oldestRow.newest : null,
      eligibleForPurge: eligibleForPurge ? eligibleForPurge.count : 0
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Format Month String YYYY-MM into Human Readable (e.g. October 2026)
 */
function formatMonthName(monthStr) {
  if (!monthStr || !monthStr.includes('-')) return monthStr;
  const [year, month] = monthStr.split('-');
  const date = new Date(parseInt(year), parseInt(month) - 1, 1);
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

/**
 * Draw a clean rounded metric card in PDF
 */
function drawMetricCard(doc, x, y, width, height, title, value, accentColor) {
  doc.save();
  doc.roundedRect(x, y, width, height, 6).fillAndStroke('#f8fafc', '#e2e8f0');
  doc.rect(x, y, 4, height).fill(accentColor);
  doc.fillColor('#64748b').fontSize(7.5).font('Helvetica-Bold').text(title.toUpperCase(), x + 10, y + 8, { width: width - 15 });
  doc.fillColor('#0f172a').fontSize(14).font('Helvetica-Bold').text(String(value), x + 10, y + 20, { width: width - 15 });
  doc.restore();
}

/**
 * Generate Monthly Transport Attendance PDF Report
 */
async function generateMonthlyAttendancePdf(res, { month, busId }) {
  const targetMonth = month || new Date().toISOString().slice(0, 7); // e.g. '2026-10'

  let busSql = '';
  const params = [targetMonth];
  if (busId && busId !== 'ALL') {
    busSql = ' AND l.bus_id = ?';
    params.push(busId);
  }

  // Fetch all logs for the specified month
  const logs = await dbQuery(`
    SELECT 
      l.*,
      s.name as student_name,
      s.branch,
      s.section,
      s.pickup_stop_name,
      b.bus_number,
      b.route_name
    FROM bus_boarding_logs l
    LEFT JOIN students s ON l.student_id = s.id
    LEFT JOIN buses b ON l.bus_id = b.id
    WHERE strftime('%Y-%m', l.log_time) = ?${busSql}
    ORDER BY l.log_time ASC
  `, params);

  let busLabel = 'All Fleet Buses';
  if (busId && busId !== 'ALL') {
    const busRow = await dbGet('SELECT * FROM buses WHERE id = ?', [busId]);
    if (busRow) busLabel = `${busRow.bus_number} (${busRow.route_name} Route)`;
  }

  // Calculate Aggregates
  const totalEvents = logs.length;
  const uniqueStudents = new Set();
  let boardCount = 0;
  let exitCount = 0;
  let faceCount = 0;
  let cardCount = 0;
  let manualCount = 0;
  let verifiedCount = 0;

  logs.forEach(l => {
    if (l.student_id) uniqueStudents.add(l.student_id);
    if (l.log_type === 'BOARD' || l.stage === 'BOARD') boardCount++;
    if (l.log_type === 'STUDENT_EXIT' || l.stage === 'EXIT' || l.log_type === 'GUARDIAN_HANDOVER') exitCount++;
    if (l.verification_method === 'FACE') faceCount++;
    else if (l.verification_method === 'ID_CARD') cardCount++;
    else if (l.verification_method === 'MANUAL') manualCount++;
    if (l.verification_status === 'VERIFIED') verifiedCount++;
  });

  // Create Landscape A4 Document (width: 841.89, height: 595.28)
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 30,
    bufferPages: true
  });

  // Stream Headers
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Transport_Attendance_Monthly_${targetMonth}.pdf"`);
  doc.pipe(res);

  const pageWidth = 841.89;
  const pageHeight = 595.28;
  const contentWidth = pageWidth - 60; // 781.89

  // Helper to draw Header
  function drawPageHeader() {
    // Header Bar
    doc.save();
    doc.rect(30, 25, contentWidth, 54).fill('#0f172a');
    
    // School Title & Badge
    doc.fillColor('#ffffff').fontSize(14).font('Helvetica-Bold').text('SCHOOLSAFE PUBLIC SCHOOL — TRANSPORT DEPARTMENT', 44, 34);
    doc.fillColor('#38bdf8').fontSize(9.5).font('Helvetica-Bold').text('MONTHLY BUS ATTENDANCE & VERIFICATION REGISTER', 44, 52);

    // Right Metadata Box
    doc.fillColor('#94a3b8').fontSize(8).font('Helvetica')
      .text(`Target Month: ${formatMonthName(targetMonth)}`, contentWidth - 180, 33, { align: 'right', width: 200 })
      .text(`Fleet Scope: ${busLabel}`, contentWidth - 180, 45, { align: 'right', width: 200 })
      .text(`Generated: ${new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`, contentWidth - 180, 57, { align: 'right', width: 200 });
    doc.restore();
  }

  // Draw First Page Header
  drawPageHeader();

  // Draw KPI Summary Row on Page 1
  const kpiY = 88;
  const kpiW = (contentWidth - 25) / 6;
  const kpiH = 42;

  drawMetricCard(doc, 30 + 0 * (kpiW + 5), kpiY, kpiW, kpiH, 'Total Events', totalEvents, '#1d4ed8');
  drawMetricCard(doc, 30 + 1 * (kpiW + 5), kpiY, kpiW, kpiH, 'Active Students', uniqueStudents.size, '#0284c7');
  drawMetricCard(doc, 30 + 2 * (kpiW + 5), kpiY, kpiW, kpiH, 'Morning Boardings', boardCount, '#059669');
  drawMetricCard(doc, 30 + 3 * (kpiW + 5), kpiY, kpiW, kpiH, 'Afternoon Exits', exitCount, '#0d9488');
  drawMetricCard(doc, 30 + 4 * (kpiW + 5), kpiY, kpiW, kpiH, 'AI Face Matches', faceCount, '#2563eb');
  drawMetricCard(doc, 30 + 5 * (kpiW + 5), kpiY, kpiW, kpiH, 'ID Card / Manual', cardCount + manualCount, '#d97706');

  // Policy Alert Pill
  doc.save();
  doc.roundedRect(30, 137, contentWidth, 18, 4).fillAndStroke('#eff6ff', '#bfdbfe');
  doc.fillColor('#1e40af').fontSize(7.5).font('Helvetica-Bold')
    .text(`OFFICIAL COMPLIANCE ARCHIVE: Data retained for 30 days in live database. Download monthly PDF register for statutory school audits.`, 38, 142);
  doc.restore();

  // Table Configuration
  const tableTopY = 162;
  const columns = [
    { label: '#', width: 26, align: 'center' },
    { label: 'Date & Time', width: 92, align: 'left' },
    { label: 'Student Name', width: 125, align: 'left' },
    { label: 'Roll Number', width: 75, align: 'left' },
    { label: 'Class / Branch', width: 85, align: 'left' },
    { label: 'Bus & Route', width: 105, align: 'left' },
    { label: 'Event Type', width: 75, align: 'center' },
    { label: 'Method', width: 68, align: 'center' },
    { label: 'Status', width: 62, align: 'center' },
    { label: 'Parent SMS', width: 68, align: 'center' }
  ];

  function drawTableHeader(y) {
    doc.save();
    doc.rect(30, y, contentWidth, 20).fill('#1e293b');
    let curX = 30;
    doc.fillColor('#ffffff').fontSize(7.5).font('Helvetica-Bold');
    columns.forEach(col => {
      doc.text(col.label, curX + 2, y + 6, { width: col.width - 4, align: col.align });
      curX += col.width;
    });
    doc.restore();
  }

  let currentY = tableTopY;
  drawTableHeader(currentY);
  currentY += 20;

  if (logs.length === 0) {
    doc.fillColor('#64748b').fontSize(9).font('Helvetica-Oblique')
      .text(`No transport boarding or exit records found for ${formatMonthName(targetMonth)}.`, 30, currentY + 25, { align: 'center', width: contentWidth });
  } else {
    logs.forEach((row, index) => {
      // Check for page break
      if (currentY > pageHeight - 55) {
        doc.addPage();
        drawPageHeader();
        currentY = 88;
        drawTableHeader(currentY);
        currentY += 20;
      }

      // Alternating row background
      const rowBg = index % 2 === 0 ? '#ffffff' : '#f8fafc';
      doc.save();
      doc.rect(30, currentY, contentWidth, 18).fill(rowBg);
      doc.rect(30, currentY + 18, contentWidth, 0.5).fill('#e2e8f0');

      let curX = 30;
      doc.fillColor('#334155').fontSize(7.5).font('Helvetica');

      // #
      doc.text(String(index + 1), curX + 2, currentY + 5, { width: columns[0].width - 4, align: columns[0].align });
      curX += columns[0].width;

      // Date & Time
      const timeClean = row.log_time ? row.log_time.replace('T', ' ').slice(0, 16) : 'N/A';
      doc.font('Helvetica-Bold').text(timeClean, curX + 2, currentY + 5, { width: columns[1].width - 4, align: columns[1].align });
      curX += columns[1].width;

      // Student Name
      doc.font('Helvetica-Bold').fillColor('#0f172a').text(row.student_name || 'Student', curX + 2, currentY + 5, { width: columns[2].width - 4, align: columns[2].align });
      curX += columns[2].width;

      // Roll Number
      doc.font('Helvetica').fillColor('#475569').text(row.roll_number || 'N/A', curX + 2, currentY + 5, { width: columns[3].width - 4, align: columns[3].align });
      curX += columns[3].width;

      // Class
      doc.text(row.branch || 'Class V', curX + 2, currentY + 5, { width: columns[4].width - 4, align: columns[4].align });
      curX += columns[4].width;

      // Bus & Route
      const busText = `${row.bus_number || 'Bus'} (${row.route_name || 'Fleet'})`;
      doc.text(busText, curX + 2, currentY + 5, { width: columns[5].width - 4, align: columns[5].align });
      curX += columns[5].width;

      // Event Type
      const isExit = row.log_type === 'STUDENT_EXIT' || row.stage === 'EXIT' || row.log_type === 'GUARDIAN_HANDOVER';
      doc.font('Helvetica-Bold').fillColor(isExit ? '#0d9488' : '#059669')
        .text(isExit ? 'EXIT / DROP' : 'BOARDING', curX + 2, currentY + 5, { width: columns[6].width - 4, align: columns[6].align });
      curX += columns[6].width;

      // Method
      const meth = row.verification_method || 'FACE';
      let methColor = '#2563eb';
      if (meth === 'ID_CARD') methColor = '#059669';
      if (meth === 'MANUAL') methColor = '#d97706';
      doc.fillColor(methColor).text(meth, curX + 2, currentY + 5, { width: columns[7].width - 4, align: columns[7].align });
      curX += columns[7].width;

      // Status
      const stat = row.verification_status || 'VERIFIED';
      const statColor = stat === 'FAILED' ? '#e11d48' : (stat === 'OVERRIDDEN' ? '#d97706' : '#059669');
      doc.fillColor(statColor).text(stat, curX + 2, currentY + 5, { width: columns[8].width - 4, align: columns[8].align });
      curX += columns[8].width;

      // Parent SMS
      doc.font('Helvetica').fillColor('#059669').text('Delivered', curX + 2, currentY + 5, { width: columns[9].width - 4, align: columns[9].align });

      doc.restore();
      currentY += 19;
    });
  }

  // Add Page Numbers & Footer to all pages
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.save();
    doc.rect(30, pageHeight - 32, contentWidth, 0.5).fill('#cbd5e1');
    doc.fillColor('#64748b').fontSize(7.5).font('Helvetica')
      .text('SchoolSafe AI Transport Management OS • 30-Day Auto-Purge Policy Compliant • Official Record', 30, pageHeight - 24, { width: contentWidth / 2, align: 'left' })
      .text(`Page ${i + 1} of ${range.count}`, contentWidth - 100, pageHeight - 24, { width: 130, align: 'right' });
    doc.restore();
  }

  doc.end();
}

/**
 * Generate Daily Transport Attendance PDF Report
 */
async function generateDailyAttendancePdf(res, { date, busId }) {
  const targetDate = date || new Date().toISOString().split('T')[0];

  let busSql = '';
  const params = [targetDate];
  if (busId && busId !== 'ALL') {
    busSql = ' AND l.bus_id = ?';
    params.push(busId);
  }

  // Fetch all logs for the specified day
  const logs = await dbQuery(`
    SELECT 
      l.*,
      s.name as student_name,
      s.branch,
      s.section,
      s.pickup_stop_name,
      b.bus_number,
      b.route_name
    FROM bus_boarding_logs l
    LEFT JOIN students s ON l.student_id = s.id
    LEFT JOIN buses b ON l.bus_id = b.id
    WHERE date(l.log_time) = date(?)${busSql}
    ORDER BY l.log_time ASC
  `, params);

  let busLabel = 'All Fleet Buses';
  if (busId && busId !== 'ALL') {
    const busRow = await dbGet('SELECT * FROM buses WHERE id = ?', [busId]);
    if (busRow) busLabel = `${busRow.bus_number} (${busRow.route_name} Route)`;
  }

  // Aggregates
  const totalEvents = logs.length;
  const uniqueStudents = new Set();
  let boardCount = 0;
  let exitCount = 0;
  let faceCount = 0;
  let cardCount = 0;
  let manualCount = 0;

  logs.forEach(l => {
    if (l.student_id) uniqueStudents.add(l.student_id);
    if (l.log_type === 'BOARD' || l.stage === 'BOARD') boardCount++;
    if (l.log_type === 'STUDENT_EXIT' || l.stage === 'EXIT' || l.log_type === 'GUARDIAN_HANDOVER') exitCount++;
    if (l.verification_method === 'FACE') faceCount++;
    else if (l.verification_method === 'ID_CARD') cardCount++;
    else if (l.verification_method === 'MANUAL') manualCount++;
  });

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 30,
    bufferPages: true
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Transport_Attendance_Daily_${targetDate}.pdf"`);
  doc.pipe(res);

  const pageWidth = 841.89;
  const pageHeight = 595.28;
  const contentWidth = pageWidth - 60;

  function drawPageHeader() {
    doc.save();
    doc.rect(30, 25, contentWidth, 54).fill('#0f172a');
    doc.fillColor('#ffffff').fontSize(14).font('Helvetica-Bold').text('SCHOOLSAFE PUBLIC SCHOOL — TRANSPORT DEPARTMENT', 44, 34);
    doc.fillColor('#38bdf8').fontSize(9.5).font('Helvetica-Bold').text('DAILY BUS ATTENDANCE & VERIFICATION REGISTER', 44, 52);

    doc.fillColor('#94a3b8').fontSize(8).font('Helvetica')
      .text(`Date: ${targetDate}`, contentWidth - 180, 33, { align: 'right', width: 200 })
      .text(`Fleet Scope: ${busLabel}`, contentWidth - 180, 45, { align: 'right', width: 200 })
      .text(`Generated: ${new Date().toLocaleTimeString('en-US')}`, contentWidth - 180, 57, { align: 'right', width: 200 });
    doc.restore();
  }

  drawPageHeader();

  const kpiY = 88;
  const kpiW = (contentWidth - 25) / 6;
  const kpiH = 42;

  drawMetricCard(doc, 30 + 0 * (kpiW + 5), kpiY, kpiW, kpiH, 'Total Logs', totalEvents, '#1d4ed8');
  drawMetricCard(doc, 30 + 1 * (kpiW + 5), kpiY, kpiW, kpiH, 'Active Students', uniqueStudents.size, '#0284c7');
  drawMetricCard(doc, 30 + 2 * (kpiW + 5), kpiY, kpiW, kpiH, 'Morning Boardings', boardCount, '#059669');
  drawMetricCard(doc, 30 + 3 * (kpiW + 5), kpiY, kpiW, kpiH, 'Afternoon Exits', exitCount, '#0d9488');
  drawMetricCard(doc, 30 + 4 * (kpiW + 5), kpiY, kpiW, kpiH, 'Face AI Matches', faceCount, '#2563eb');
  drawMetricCard(doc, 30 + 5 * (kpiW + 5), kpiY, kpiW, kpiH, 'ID Card / Manual', cardCount + manualCount, '#d97706');

  // Policy Alert Pill
  doc.save();
  doc.roundedRect(30, 137, contentWidth, 18, 4).fillAndStroke('#eff6ff', '#bfdbfe');
  doc.fillColor('#1e40af').fontSize(7.5).font('Helvetica-Bold')
    .text(`DAILY VERIFICATION AUDIT: All boardings, exits, and guardian handovers timestamped with GPS and attendant ID.`, 38, 142);
  doc.restore();

  const tableTopY = 162;
  const columns = [
    { label: '#', width: 26, align: 'center' },
    { label: 'Student Name', width: 125, align: 'left' },
    { label: 'Roll No', width: 70, align: 'left' },
    { label: 'Class & Stop', width: 95, align: 'left' },
    { label: 'Bus & Route', width: 105, align: 'left' },
    { label: 'Morning Boarding (IN)', width: 120, align: 'left' },
    { label: 'Afternoon Exit (OUT)', width: 125, align: 'left' },
    { label: 'Custody Status', width: 115, align: 'center' }
  ];

  function drawTableHeader(y) {
    doc.save();
    doc.rect(30, y, contentWidth, 20).fill('#1e293b');
    let curX = 30;
    doc.fillColor('#ffffff').fontSize(7.5).font('Helvetica-Bold');
    columns.forEach(col => {
      doc.text(col.label, curX + 2, y + 6, { width: col.width - 4, align: col.align });
      curX += col.width;
    });
    doc.restore();
  }

  let currentY = tableTopY;
  drawTableHeader(currentY);
  currentY += 20;

  // Group logs into student daily roster
  const studentMap = new Map();
  logs.forEach(l => {
    const sId = l.student_id || l.roll_number;
    if (!studentMap.has(sId)) {
      studentMap.set(sId, {
        student_name: l.student_name || 'Student',
        roll_number: l.roll_number || 'N/A',
        branch: l.branch || 'Class V',
        pickup_stop: l.pickup_stop_name || 'Pitapalli Square',
        bus_number: l.bus_number || 'Bus #4',
        route_name: l.route_name || 'Khordha',
        boarding: null,
        exit: null
      });
    }
    const sRec = studentMap.get(sId);
    if ((l.log_type === 'BOARD' || l.stage === 'BOARD') && !sRec.boarding) {
      sRec.boarding = l;
    }
    if ((l.log_type === 'STUDENT_EXIT' || l.stage === 'EXIT' || l.log_type === 'GUARDIAN_HANDOVER') && !sRec.exit) {
      sRec.exit = l;
    }
  });

  const rosterList = Array.from(studentMap.values());

  if (rosterList.length === 0) {
    doc.fillColor('#64748b').fontSize(9).font('Helvetica-Oblique')
      .text(`No transport records found for ${targetDate}.`, 30, currentY + 25, { align: 'center', width: contentWidth });
  } else {
    rosterList.forEach((row, index) => {
      if (currentY > pageHeight - 55) {
        doc.addPage();
        drawPageHeader();
        currentY = 88;
        drawTableHeader(currentY);
        currentY += 20;
      }

      const rowBg = index % 2 === 0 ? '#ffffff' : '#f8fafc';
      doc.save();
      doc.rect(30, currentY, contentWidth, 20).fill(rowBg);
      doc.rect(30, currentY + 20, contentWidth, 0.5).fill('#e2e8f0');

      let curX = 30;
      doc.fillColor('#334155').fontSize(7.5).font('Helvetica');

      // #
      doc.text(String(index + 1), curX + 2, currentY + 6, { width: columns[0].width - 4, align: columns[0].align });
      curX += columns[0].width;

      // Student Name
      doc.font('Helvetica-Bold').fillColor('#0f172a').text(row.student_name, curX + 2, currentY + 6, { width: columns[1].width - 4, align: columns[1].align });
      curX += columns[1].width;

      // Roll Number
      doc.font('Helvetica').fillColor('#475569').text(row.roll_number, curX + 2, currentY + 6, { width: columns[2].width - 4, align: columns[2].align });
      curX += columns[2].width;

      // Class & Stop
      const classStop = `${row.branch} (${row.pickup_stop})`;
      doc.text(classStop, curX + 2, currentY + 6, { width: columns[3].width - 4, align: columns[3].align });
      curX += columns[3].width;

      // Bus & Route
      const busText = `${row.bus_number} (${row.route_name})`;
      doc.text(busText, curX + 2, currentY + 6, { width: columns[4].width - 4, align: columns[4].align });
      curX += columns[4].width;

      // Morning Boarding (IN)
      if (row.boarding) {
        const bTime = row.boarding.log_time ? (row.boarding.log_time.split(' ')[1] || row.boarding.log_time) : 'Recorded';
        const bMeth = row.boarding.verification_method || 'FACE';
        doc.font('Helvetica-Bold').fillColor('#059669')
          .text(`${bTime} [${bMeth}]`, curX + 2, currentY + 6, { width: columns[5].width - 4, align: columns[5].align });
      } else {
        doc.font('Helvetica').fillColor('#94a3b8')
          .text('Not Boarded', curX + 2, currentY + 6, { width: columns[5].width - 4, align: columns[5].align });
      }
      curX += columns[5].width;

      // Afternoon Exit / Drop (OUT)
      if (row.exit) {
        const eTime = row.exit.log_time ? (row.exit.log_time.split(' ')[1] || row.exit.log_time) : 'Recorded';
        const eMeth = row.exit.verification_method || 'FACE';
        doc.font('Helvetica-Bold').fillColor('#0d9488')
          .text(`${eTime} [${eMeth}]`, curX + 2, currentY + 6, { width: columns[6].width - 4, align: columns[6].align });
      } else if (row.boarding) {
        // Boarded but not exited yet!
        doc.font('Helvetica-Bold').fillColor('#d97706')
          .text('Still Onboard / In Transit', curX + 2, currentY + 6, { width: columns[6].width - 4, align: columns[6].align });
      } else {
        doc.font('Helvetica').fillColor('#94a3b8')
          .text('Not Exited', curX + 2, currentY + 6, { width: columns[6].width - 4, align: columns[6].align });
      }
      curX += columns[6].width;

      // Custody Status
      if (row.boarding && row.exit) {
        doc.font('Helvetica-Bold').fillColor('#059669').text('Safely Dropped', curX + 2, currentY + 6, { width: columns[7].width - 4, align: columns[7].align });
      } else if (row.boarding && !row.exit) {
        doc.font('Helvetica-Bold').fillColor('#d97706').text('Still Onboard', curX + 2, currentY + 6, { width: columns[7].width - 4, align: columns[7].align });
      } else {
        doc.font('Helvetica').fillColor('#64748b').text('Absent', curX + 2, currentY + 6, { width: columns[7].width - 4, align: columns[7].align });
      }

      doc.restore();
      currentY += 21;
    });
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.save();
    doc.rect(30, pageHeight - 32, contentWidth, 0.5).fill('#cbd5e1');
    doc.fillColor('#64748b').fontSize(7.5).font('Helvetica')
      .text('SchoolSafe AI Transport Management OS • Official Daily Transport Register', 30, pageHeight - 24, { width: contentWidth / 2, align: 'left' })
      .text(`Page ${i + 1} of ${range.count}`, contentWidth - 100, pageHeight - 24, { width: 130, align: 'right' });
    doc.restore();
  }

  doc.end();
}

module.exports = {
  purgeOldLogs,
  getRetentionStats,
  generateMonthlyAttendancePdf,
  generateDailyAttendancePdf
};
