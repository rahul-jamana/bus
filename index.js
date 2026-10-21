const { onRequest } = require('firebase-functions/v2/https');
const { app, initDatabase } = require('./server');

// Ensure database initialization on serverless warm starts
let dbInitialized = false;
async function ensureDb() {
  if (!dbInitialized) {
    try {
      await initDatabase();
      dbInitialized = true;
    } catch (err) {
      console.error('Firebase Cloud Function DB initialization error:', err);
    }
  }
}

exports.api = onRequest({ cors: true, timeoutSeconds: 60, memory: '512MiB' }, async (req, res) => {
  await ensureDb();
  return app(req, res);
});

// Fallback: If executed directly (e.g., node index.js on Render/PaaS)
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  initDatabase()
    .then(() => {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`====================================================`);
        console.log(`🚀 Face Detection Attendance System running on Render!`);
        console.log(`🌐 Production Web Server listening on port ${PORT}`);
        console.log(`====================================================`);
      });
    })
    .catch((err) => {
      console.error('Failed to initialize database on Render:', err);
      process.exit(1);
    });
}
