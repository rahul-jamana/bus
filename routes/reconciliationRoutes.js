/**
 * SafeRide AI — Stop-Level Custody Reconciliation API Routes
 * 
 * Endpoints:
 * - POST /trips/:id/start
 * - POST /events/board
 * - POST /events/exit
 * - POST /stops/:id/depart
 * - POST /incidents/:id/resolve
 * - GET  /trips/:id/status
 * - GET  /dashboard/incidents?status=OPEN
 * - POST /trips/:id/sync (Offline event synchronization)
 * - POST /trips/:id/end
 */

const express = require('express');
const router = express.Router();
const { reconciliationEngine } = require('../utils/reconciliationEngine');

// POST /trips/:id/start - Starts trip & builds plan map
router.post('/trips/:id/start', async (req, res) => {
  try {
    const tripId = req.params.id;
    const { route_id = 1, bus_id = 1, driver_id, attendant_id, actor_id } = req.body;
    const result = await reconciliationEngine.startTrip({
      tripId,
      routeId: route_id,
      busId: bus_id,
      driverId: driver_id,
      attendantId: attendant_id,
      actorId: actor_id
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /stops/:id/enter - Geofence enter event (activates expected list)
router.post('/stops/:id/enter', async (req, res) => {
  try {
    const stopId = req.params.id;
    const { trip_id, actor_id } = req.body;
    const result = await reconciliationEngine.handleGeofenceEnter({
      tripId: trip_id,
      stopId,
      actorId: actor_id
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /events/board - Records a student boarding event
router.post('/events/board', async (req, res) => {
  try {
    const { trip_id, student_id, method = 'QR', stop_id, device_ts, device_id, reason, actor_id } = req.body;
    const result = await reconciliationEngine.recordEvent({
      tripId: trip_id,
      studentId: student_id,
      type: 'BOARD',
      method,
      stopId: stop_id,
      timestamp: device_ts || new Date().toISOString(),
      deviceId: device_id,
      reason,
      actorId: actor_id
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /events/exit - Records a student drop-off exit event
router.post('/events/exit', async (req, res) => {
  try {
    const { trip_id, student_id, method = 'QR', stop_id, device_ts, device_id, reason, actor_id } = req.body;
    const result = await reconciliationEngine.recordEvent({
      tripId: trip_id,
      studentId: student_id,
      type: 'EXIT',
      method,
      stopId: stop_id,
      timestamp: device_ts || new Date().toISOString(),
      deviceId: device_id,
      reason,
      actorId: actor_id
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /stops/:id/depart - Triggers reconciliation, returns {pending[], incidents[]}
router.post('/stops/:id/depart', async (req, res) => {
  try {
    const stopId = req.params.id;
    const { trip_id, strict_mode, actor_id } = req.body;
    const result = await reconciliationEngine.departStop({
      tripId: trip_id,
      stopId,
      strictMode: strict_mode,
      actorId: actor_id
    });
    if (result.blocked) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /incidents/:id/resolve - Attendant resolution actions
router.post('/incidents/:id/resolve', async (req, res) => {
  try {
    const incidentId = req.params.id;
    const { action, reason, actor_id } = req.body;
    const result = await reconciliationEngine.resolveIncident({
      incidentId,
      action,
      reason,
      actorId: actor_id
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /trips/:id/status - Live pending list per stop
router.get('/trips/:id/status', async (req, res) => {
  try {
    const tripId = req.params.id;
    const result = await reconciliationEngine.getTripStatus(tripId);
    if (!result) return res.status(404).json({ success: false, message: 'Trip not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /dashboard/incidents?status=OPEN - Incident queue with SLA timer
router.get('/dashboard/incidents', async (req, res) => {
  try {
    const status = req.query.status || 'OPEN';
    const incidents = await reconciliationEngine.getDashboardIncidents(status);
    res.json({
      success: true,
      count: incidents.length,
      incidents
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /trips/:id/sync - Offline event synchronization
router.post('/trips/:id/sync', async (req, res) => {
  try {
    const tripId = req.params.id;
    const { events = [], actor_id } = req.body;
    const result = await reconciliationEngine.handleOfflineSync({
      tripId,
      events,
      actorId: actor_id
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /trips/:id/end - Complete trip & final reconciliation
router.post('/trips/:id/end', async (req, res) => {
  try {
    const tripId = req.params.id;
    const { actor_id } = req.body;
    const result = await reconciliationEngine.endTrip({
      tripId,
      actorId: actor_id
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /stops - Retrieve all active bus stops
router.get('/stops', async (req, res) => {
  try {
    const { dbQuery } = require('../db/database');
    const stops = await dbQuery('SELECT * FROM stops ORDER BY sequence ASC');
    res.json({ success: true, count: stops.length, stops });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /routes - Retrieve all active routes
router.get('/routes', async (req, res) => {
  try {
    const { dbQuery } = require('../db/database');
    const routes = await dbQuery('SELECT * FROM routes ORDER BY id ASC');
    res.json({ success: true, count: routes.length, routes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /expected-drops - Retrieve all real student drop mappings
router.get('/expected-drops', async (req, res) => {
  try {
    const { dbQuery } = require('../db/database');
    const drops = await dbQuery(`
      SELECT ed.*, s.name as student_name, s.roll_number, s.class, st.name as stop_name
      FROM expected_drops ed
      JOIN students s ON ed.student_id = s.id
      JOIN stops st ON ed.stop_id = st.id
      ORDER BY st.sequence ASC, s.name ASC
    `);
    res.json({ success: true, count: drops.length, expected_drops: drops });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
