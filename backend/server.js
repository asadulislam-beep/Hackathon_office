/**
 * OfficeQuest backend
 * Single source of truth for device state, shared by the web dashboard
 * and the Discord bot. In-memory only — restart clears state (fine for
 * a hackathon demo; swap for SQLite/Redis if you need persistence).
 */
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const FAN_WATT = 60;
const LIGHT_WATT = 15;
const ROOMS = ["Drawing Room", "Work Room 1", "Work Room 2"];

// ---------- Device state ----------
function buildDevices() {
  const devices = [];
  ROOMS.forEach((room) => {
    for (let i = 1; i <= 2; i++) {
      devices.push({
        id: `${room}-fan-${i}`,
        type: "fan",
        label: `Fan ${i}`,
        room,
        watt: FAN_WATT,
        on: Math.random() < 0.5,
        lastChanged: Date.now() - Math.random() * 3 * 3600 * 1000,
      });
    }
    for (let i = 1; i <= 3; i++) {
      devices.push({
        id: `${room}-light-${i}`,
        type: "light",
        label: `Light ${i}`,
        room,
        watt: LIGHT_WATT,
        on: Math.random() < 0.5,
        lastChanged: Date.now() - Math.random() * 3 * 3600 * 1000,
      });
    }
  });
  return devices;
}

let devices = buildDevices();

// Simulate real-world drift so the demo always has something live to show.
setInterval(() => {
  const idx = Math.floor(Math.random() * devices.length);
  if (Math.random() < 0.35) {
    devices[idx].on = !devices[idx].on;
    devices[idx].lastChanged = Date.now();
  }
}, 3000);

// ---------- Derived helpers ----------
function isOfficeHours(date = new Date()) {
  const h = date.getHours();
  return h >= 9 && h < 17;
}

function totalPower() {
  return devices.filter((d) => d.on).reduce((sum, d) => sum + d.watt, 0);
}

function powerByRoom() {
  return ROOMS.map((room) => ({
    room,
    watt: devices
      .filter((d) => d.room === room && d.on)
      .reduce((s, d) => s + d.watt, 0),
  }));
}

function computeAlerts() {
  const alerts = [];
  const now = new Date();
  const officeHrs = isOfficeHours(now);

  if (!officeHrs) {
    devices
      .filter((d) => d.on)
      .forEach((d) => {
        alerts.push({
          level: "danger",
          message: `${d.label} in ${d.room} is still ON after office hours.`,
          ts: Date.now(),
        });
      });
  }

  ROOMS.forEach((room) => {
    const roomDevices = devices.filter((d) => d.room === room);
    const allOn = roomDevices.every((d) => d.on);
    const oldest = Math.min(...roomDevices.map((d) => d.lastChanged));
    if (allOn && Date.now() - oldest > 2 * 3600 * 1000) {
      alerts.push({
        level: "warn",
        message: `${room} has had all devices ON continuously for 2+ hours.`,
        ts: Date.now(),
      });
    }
  });

  return alerts;
}

// Rough running-total estimate for "today's kWh" — same formula the
// dashboard uses, so both surfaces stay consistent.
function estimatedKwhToday() {
  const now = new Date();
  const hoursElapsed = now.getHours() + now.getMinutes() / 60;
  return +((totalPower() / 1000) * hoursElapsed).toFixed(2);
}

// ---------- Routes ----------
app.get("/api/devices", (req, res) => res.json(devices));

// Accepts loose input: "work1", "Work Room 1", "workroom1", "drawing" all
// resolve to the same room, by stripping the word "room" and non-alphanumerics.
function normalizeRoom(s) {
  return s.toLowerCase().replace(/room/g, "").replace(/[^a-z0-9]/g, "");
}

app.get("/api/devices/room/:room", (req, res) => {
  const target = normalizeRoom(req.params.room);
  const match = ROOMS.find((r) => normalizeRoom(r) === target);
  if (!match) {
    return res.status(404).json({ error: `Unknown room: ${req.params.room}`, validRooms: ROOMS });
  }
  res.json(devices.filter((d) => d.room === match));
});

app.get("/api/power", (req, res) => {
  res.json({
    totalWatt: totalPower(),
    estimatedKwhToday: estimatedKwhToday(),
    byRoom: powerByRoom(),
  });
});

app.get("/api/alerts", (req, res) => res.json(computeAlerts()));

app.get("/api/status", (req, res) => {
  res.json({
    officeHours: isOfficeHours(),
    devices,
    power: {
      totalWatt: totalPower(),
      estimatedKwhToday: estimatedKwhToday(),
      byRoom: powerByRoom(),
    },
    alerts: computeAlerts(),
  });
});

app.listen(PORT, () => {
  console.log(`OfficeQuest backend running on http://localhost:${PORT}`);
});
