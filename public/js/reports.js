// Reports, Analytics, & Export Engine
let trendChartInstance = null;
let deptChartInstance = null;
let pieChartInstance = null;

document.addEventListener('DOMContentLoaded', () => {
  initExportHandlers();
});

function initExportHandlers() {
  document.getElementById('btn-export-pdf')?.addEventListener('click', exportToPDF);
  document.getElementById('btn-export-excel')?.addEventListener('click', exportToExcel);
  document.getElementById('btn-export-csv')?.addEventListener('click', exportToCSV);
}

// Render Dashboard Trend Line Chart
function renderTrendChart(trendData) {
  const ctx = document.getElementById('chart-attendance-trend')?.getContext('2d');
  if (!ctx || !trendData) return;

  const labels = trendData.map(t => t.day);
  const counts = trendData.map(t => t.present);

  if (trendChartInstance) {
    trendChartInstance.destroy();
  }

  trendChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Students Present',
        data: counts,
        borderColor: '#38bdf8',
        backgroundColor: 'rgba(56, 189, 248, 0.12)',
        borderWidth: 3,
        tension: 0.4,
        fill: true,
        pointBackgroundColor: '#38bdf8',
        pointRadius: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' }, beginAtZero: true }
      }
    }
  });
}

// Render Full Reports Studio Page
async function renderReports() {
  try {
    const res = await fetch('/api/reports/dashboard');
    const data = await res.json();
    if (!data.success) return;

    // Render Department List Progress Bars
    const listEl = document.getElementById('report-dept-list');
    if (listEl) {
      listEl.innerHTML = data.departments.map(d => `
        <div class="mb-3">
          <div class="d-flex justify-content-between mb-1">
            <span class="fw-semibold">${d.department}</span>
            <span class="text-accent fw-bold">${d.present} / ${d.total} (${d.percentage}%)</span>
          </div>
          <div class="progress-bar-container">
            <div class="progress-fill" style="width: ${d.percentage}%;"></div>
          </div>
        </div>
      `).join('');
    }

    // Department Bar Chart
    const deptCtx = document.getElementById('chart-dept-breakdown')?.getContext('2d');
    if (deptCtx) {
      if (deptChartInstance) deptChartInstance.destroy();
      deptChartInstance = new Chart(deptCtx, {
        type: 'bar',
        data: {
          labels: data.departments.map(d => d.department),
          datasets: [
            { label: 'Present', data: data.departments.map(d => d.present), backgroundColor: '#10b981' },
            { label: 'Absent', data: data.departments.map(d => d.absent), backgroundColor: '#f43f5e' }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { labels: { color: '#94a3b8' } } },
          scales: {
            x: { ticks: { color: '#94a3b8' } },
            y: { ticks: { color: '#94a3b8' }, beginAtZero: true }
          }
        }
      });
    }

    // Punctuality Pie Chart
    const pieCtx = document.getElementById('chart-punctuality-pie')?.getContext('2d');
    if (pieCtx) {
      if (pieChartInstance) pieChartInstance.destroy();
      pieChartInstance = new Chart(pieCtx, {
        type: 'doughnut',
        data: {
          labels: ['On Time Present', 'Late Arrivals', 'Absent'],
          datasets: [{
            data: [
              Math.max(0, data.stats.presentToday - data.stats.lateToday),
              data.stats.lateToday,
              data.stats.absentToday
            ],
            backgroundColor: ['#10b981', '#f59e0b', '#f43f5e']
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { labels: { color: '#94a3b8' } } }
        }
      });
    }
  } catch (err) {
    console.error('Error rendering reports:', err);
  }
}

// Export Report as PDF using html2pdf
function exportToPDF() {
  const element = document.getElementById('report-printable-area');
  if (!element) return;

  window.showToast('Generating PDF Report... Please wait.', 'info');
  const opt = {
    margin: 10,
    filename: `Attendance_Report_${new Date().toISOString().split('T')[0]}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' }
  };

  if (window.html2pdf) {
    window.html2pdf().set(opt).from(element).save().then(() => {
      window.showToast('PDF Report downloaded successfully!', 'success');
    });
  } else {
    window.print();
  }
}

// Export Report as Excel using SheetJS XLSX
async function exportToExcel() {
  try {
    const res = await fetch('/api/attendance/history');
    const data = await res.json();
    if (!data.success || data.logs.length === 0) {
      window.showToast('No attendance records available to export.', 'warning');
      return;
    }

    const excelData = data.logs.map(r => ({
      'Date': r.date,
      'Time': r.time,
      'Student ID': r.student_id,
      'Name': r.name,
      'Roll Number': r.roll_number,
      'Department': r.department,
      'Status': r.status,
      'Verification Mode': r.mode,
      'Match Confidence (%)': r.confidence || 100
    }));

    if (window.XLSX) {
      const worksheet = XLSX.utils.json_to_sheet(excelData);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Attendance Records');
      XLSX.writeFile(workbook, `Attendance_Export_${new Date().toISOString().split('T')[0]}.xlsx`);
      window.showToast('Excel workbook exported successfully!', 'success');
    }
  } catch (err) {
    console.error('Excel Export Error:', err);
    window.showToast('Failed to export Excel file.', 'danger');
  }
}

// Export CSV via Backend Stream
function exportToCSV() {
  const date = document.getElementById('log-date-filter')?.value || '';
  const dept = document.getElementById('log-dept-filter')?.value || 'All';
  window.location.href = `/api/reports/export/csv?date=${date}&department=${encodeURIComponent(dept)}`;
  window.showToast('CSV export download started.', 'success');
}

window.renderTrendChart = renderTrendChart;
window.renderReports = renderReports;
