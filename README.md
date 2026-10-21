# 🚸 SchoolSafe — School Bus Live Tracking & Child In/Out Safety Platform 🚍

[![Node.js Version](https://img.shields.io/badge/Node.js-v20%2B-blue?style=flat&logo=node.js)](https://nodejs.org/)
[![Firebase](https://img.shields.io/badge/Firebase-buss--b1d0f-orange?style=flat&logo=firebase)](https://firebase.google.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![UI Theme](https://img.shields.io/badge/Theme-Clean%20Blue%20%26%20White-0284c7)](https://leafletjs.com/)

An end-to-end, zero-hardware digital platform designed to make school transportation safe, verifiable, and transparent. It connects school authorities, drivers, and parents in real time through **Driver Smartphone GPS Telemetry**, **Bus Door AI Face Recognition (Boarding & Drop-Off)**, and **Instant Child Photo Verification Proof**.

---

## 🎯 The Problem We Solve

School transportation is critical to student safety, but most schools and parents face major operational challenges:
- **Parent Anxiety & Uncertainty**: Parents don't know the exact location of the bus or when it will arrive, often waiting anxiously in severe weather.
- **Dangerous Driving Distractions**: Parents repeatedly call drivers while they are navigating traffic, creating severe road accident risks.
- **Lost ID Cards & Unreliable Tracking**: Young children frequently lose RFID tags or smart passes.
- **Prohibitive Hardware Costs**: Commercial GPS hardware boxes and fleet telemetry installations are expensive and difficult for smaller schools to maintain.

**SchoolSafe** eliminates the need for expensive third-party GPS boxes or physical cards by leveraging standard smartphones, webcams, and AI face recognition.

---

## 🌟 Key System Capabilities

| Feature | How It Works | Benefit |
| :--- | :--- | :--- |
| **📍 Zero-Hardware Driver GPS** | Driver opens mobile console on any smartphone mounted on the bus dashboard. Uses HTML5 `navigator.geolocation` (`enableHighAccuracy`). | Streams latitude, longitude, speed, and heading every 2.5 seconds to parents with no expensive GPS boxes. |
| **📷 Door AI Face Recognition** | Smartphone or tablet camera at the bus entrance detects faces via `@vladmandic/face-api` (SSD MobileNet V1 & 128D neural descriptors). | Scans students in $< 0.5$ seconds during **Morning Boarding** and **Evening Drop-Off**. |
| **📸 Live Photo Proof of Safety** | Camera captures an instantaneous snapshot when the child steps into or leaves the bus. | Dispatched immediately to parents with timestamp, stop name, and GPS coordinates. |
| **🗺️ Live Bus Map & ETA** | Interactive Leaflet map with custom school bus marker and live countdown timer. | Parents see: *"Bus #4 is 1.2 km away • ~4 mins to your stop"*. |
| **🔔 Instant In/Out Notifications** | Web Push, SMS, and WhatsApp notifications dispatched upon every boarding and drop-off event. | Parents never have to call the driver or school administration. |
| **🖥️ Blue & White Admin Studio** | Intuitive desktop dashboard for transport managers. | Register students, capture face embeddings via webcam, assign routes, and track fleet. |

---

## 🔄 End-to-End System Architecture

```mermaid
flowchart TD
    subgraph SchoolBus["🚍 On the School Bus"]
        DriverPhone["📱 Driver Smartphone (/driver)\n(HTML5 High-Accuracy GPS)"]
        DoorCamera["📷 Bus Door AI Camera (/bus-terminal.html)\n(VisioFace 128D Neural Face Detector)"]
    end

    subgraph CloudServer["⚙️ Node.js + Express Backend & Cloud"]
        APIGateway["REST API & Telemetry Hub\n(Port 3000)"]
        SQLiteDB["SQLite Database (attendance.db)\n• Students & Parents\n• Buses & Routes\n• Boarding Logs"]
        Firebase["🔥 Firebase Project: buss-b1d0f\n(Cloud Sync & Photo Storage)"]
    end

    subgraph EndUsers["👥 End-User Portals"]
        AdminPortal["🖥️ School Admin Console (/admin)\n• Student Registration\n• Webcam Face AI Studio\n• Live Fleet Map"]
        ParentPortal["👨‍👩‍👧 Parent Live Portal (/parent)\n• Moving Bus Map + ETA\n• Child Photo Proof Card\n• SMS Audit Log"]
    end

    DriverPhone -->|"GPS Lat, Lng, Speed (every 2.5s)"| APIGateway
    DoorCamera -->|"Face Match + Live Boarding Snapshot"| APIGateway

    APIGateway --> SQLiteDB
    APIGateway --> Firebase

    SQLiteDB --> AdminPortal
    APIGateway -->|"Real-time GPS Stream"| ParentPortal
    APIGateway -->|"Photo Proof + Time Alert"| ParentPortal
```

---

## 🌐 Application Portals & URLs

| Portal | URL Route | Description |
| :--- | :--- | :--- |
| **🏠 Main Launchpad** | `http://localhost:3000/` | Public homepage linking to all transport portals. |
| **🖥️ Transport Admin** | `http://localhost:3000/admin` | Student management, webcam face capture, fleet monitor, and notification logs. |
| **📱 Driver Mobile GPS** | `http://localhost:3000/driver` | Driver console for smartphone GPS broadcasting and student roster checklist. |
| **📷 Bus Door AI Scanner** | `http://localhost:3000/bus-terminal.html` | Tablet/camera at the bus door for biometric Morning Boarding and Safe Drop-Off scans. |
| **👨‍👩‍👧 Parent Live Tracker** | `http://localhost:3000/parent` | Real-time moving bus map, live ETA countdown, and child verification photo card. |

---

## 🔑 Default Credentials

- **Admin Username / Mobile ID**: `9040954015`
- **Admin Password**: `9040954015`
- **Role**: `Administrator`

---

## 🛠️ Technology Stack

- **Frontend**: Vanilla JavaScript (ES6+), Modern Vanilla CSS (Blue & White Design System), HTML5 Canvas, Leaflet.js, OpenStreetMap.
- **AI & Computer Vision**: Client-side `@vladmandic/face-api` (SSD MobileNet V1, 68-point facial landmarks, 128D Euclidean distance matcher).
- **Backend**: Node.js v20+, Express.js, CORS, Multer, bcryptjs, JSONWebToken.
- **Database**: Embedded SQLite (`db/attendance.db`) with automatic schema migration.
- **Cloud Integration**: Firebase project **`buss-b1d0f`** (`.firebaserc` / `firebase.json`).

---

## 📡 REST API Reference

### 🚍 Bus Telemetry & Tracking
- **`POST /api/bus/telemetry`**: Driver's phone broadcasts live coordinates.
  ```json
  { "bus_id": 1, "lat": 20.2961, "lng": 85.8245, "speed": 38, "heading": 120, "status": "ACTIVE" }
  ```
- **`GET /api/bus/telemetry/:bus_id`**: Returns current coordinates, speed, route stops, and onboard passenger count.
- **`GET /api/bus/telemetry`**: Returns live telemetry for all buses in the fleet.
- **`GET /api/bus/parent-track/:query`**: Queries student by roll number (`BEC26081`) or parent phone number, returning live bus position, assigned route stops, today's boarding photo, and SMS dispatches.

### 👤 Face Biometrics & Attendance
- **`POST /api/face/enroll`**: Registers student profile with 128D facial embeddings and reference photos.
- **`GET /api/face/descriptors`**: Returns pre-compiled descriptors of all enrolled students for client-side matching.
- **`POST /api/bus/board`**: Logs student entry into the bus, captures snapshot, and dispatches parent boarding SMS.
- **`POST /api/bus/deboard`**: Logs student exit at school/home stop and sends safe arrival alert.

### 🔐 Authentication
- **`POST /api/auth/login`**: Authenticates admin using username and password (`9040954015`).

---

## 🚀 Installation & Local Run

### Prerequisites
- [Node.js](https://nodejs.org/) v18+ or v20+
- Modern web browser (Chrome, Edge, Safari, Firefox) with camera and location permissions enabled.

### 1. Clone the Repository
```bash
git clone https://github.com/rahul-jamana/bus.git
cd bus
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Start the Server
```bash
npm start
```

### 4. Open in Browser
- **Admin Portal**: [http://localhost:3000/admin](http://localhost:3000/admin)
- **Driver GPS**: [http://localhost:3000/driver](http://localhost:3000/driver)
- **Parent Portal**: [http://localhost:3000/parent](http://localhost:3000/parent)

*(To test on a smartphone connected to the same Wi-Fi, open `http://<YOUR_LOCAL_IP>:3000`)*

---

## 📁 Repository Directory Structure

```text
bus/
├── server.js               # Primary Express application server (Port 3000)
├── package.json            # Node.js dependencies and run scripts
├── .firebaserc             # Firebase target project (buss-b1d0f)
├── .gitignore              # Ignores node_modules, logs, and database files
├── db/
│   ├── database.js         # SQLite schema initialization & master admin seed
│   └── attendance.db       # Embedded database (Students, Buses, Logs)
├── routes/
│   ├── bus.js              # Live GPS telemetry & parent tracking routes
│   ├── face.js             # 128D AI face recognition & enrollment routes
│   ├── students.js         # Student & parent contact management routes
│   ├── notifications.js    # SMS / WhatsApp in/out alert dispatcher
│   └── auth.js             # Admin authentication routes
├── uploads/                # Captured live student boarding photos
└── public/                 # Clean Modern Blue & White Interfaces
    ├── index.html          # Main Launchpad
    ├── admin.html          # 🖥️ Transport Admin Portal
    ├── driver.html         # 📱 Driver Mobile GPS Transmitter
    ├── bus-terminal.html   # 📷 Bus Door AI Camera Scanner
    └── parent.html         # 👨‍👩‍👧 Parent Live Map & Child Photo Card
```

---

## 📄 License
This project is licensed under the [MIT License](LICENSE).
