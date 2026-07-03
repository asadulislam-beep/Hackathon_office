/**
 * OfficeQuest Discord bot
 * Reads from the same backend API as the web dashboard — no data of its
 * own, so the two surfaces can never drift out of sync.
 *
 * Required env vars:
 *   DISCORD_TOKEN     - your bot token
 *   BACKEND_URL       - e.g. http://localhost:4000
 *   ALERT_CHANNEL_ID  - (optional, for the proactive-alert bonus)
 *   ANTHROPIC_API_KEY - (optional, for LLM-humanized replies)
 */
require("dotenv").config();
const { Client, GatewayIntentBits, Partials } = require("discord.js");

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:4000";
const PREFIX = "!";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ---------- Backend fetch helpers ----------
async function getStatus() {
  const res = await fetch(`${BACKEND_URL}/api/status`);
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return res.json();
}

async function getRoom(roomName) {
  const res = await fetch(
    `${BACKEND_URL}/api/devices/room/${encodeURIComponent(roomName)}`
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: true, message: body.error || "Room not found", validRooms: body.validRooms };
  }
  return { error: false, devices: await res.json() };
}

async function getPower() {
  const res = await fetch(`${BACKEND_URL}/api/power`);
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return res.json();
}

// ---------- Plain-text formatting (deterministic, no LLM needed) ----------
function summarizeRoom(room, devices) {
  const on = devices.filter((d) => d.on);
  if (on.length === 0) return `${room}: all off.`;
  const fans = on.filter((d) => d.type === "fan").length;
  const lights = on.filter((d) => d.type === "light").length;
  const parts = [];
  if (fans) parts.push(`${fans} fan${fans > 1 ? "s" : ""} ON`);
  if (lights) parts.push(`${lights} light${lights > 1 ? "s" : ""} ON`);
  return `${room}: ${parts.join(", ")}.`;
}

function formatStatus(status) {
  const byRoom = {};
  status.devices.forEach((d) => {
    byRoom[d.room] = byRoom[d.room] || [];
    byRoom[d.room].push(d);
  });
  return Object.entries(byRoom)
    .map(([room, devices]) => summarizeRoom(room, devices))
    .join(" ");
}

function formatUsage(power) {
  return `Total power right now: ${power.totalWatt}W. Today's estimated usage: ${power.estimatedKwhToday} kWh.`;
}

// ---------- Optional: humanize with Claude ----------
// Keeps the bot fully functional without an API key (falls back to the
// deterministic strings above); when a key is set, replies get friendlier.
async function humanize(rawText) {
  if (!process.env.ANTHROPIC_API_KEY) return rawText;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: `Rewrite this office-monitoring bot reply in a warm, friendly, concise tone (1-2 sentences, no markdown, keep every number exactly as given): "${rawText}"`,
          },
        ],
      }),
    });
    const data = await res.json();
    const text = data?.content?.find((b) => b.type === "text")?.text;
    return text?.trim() || rawText;
  } catch (err) {
    console.error("humanize() failed, falling back to raw text:", err.message);
    return rawText;
  }
}

// ---------- Command handling ----------
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  const [cmd, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);

  try {
    if (cmd === "status") {
      const status = await getStatus();
      const reply = await humanize(formatStatus(status));
      return message.reply(reply);
    }

    if (cmd === "room") {
      const roomName = args.join(" ");
      if (!roomName) return message.reply("Which room? Try `!room work1` or `!room drawing`.");
      const result = await getRoom(roomName);
      if (result.error) {
        return message.reply(
          `I don't recognize "${roomName}". Valid rooms: ${result.validRooms?.join(", ") || "Drawing Room, Work Room 1, Work Room 2"}.`
        );
      }
      const raw = summarizeRoom(roomName, result.devices);
      return message.reply(await humanize(raw));
    }

    if (cmd === "usage") {
      const power = await getPower();
      return message.reply(await humanize(formatUsage(power)));
    }
  } catch (err) {
    console.error(err);
    return message.reply("Couldn't reach the office backend just now — try again in a moment.");
  }
});

// ---------- Bonus: proactive alert pings ----------
// Polls /api/alerts and posts new ones to a designated channel, deduped
// so the same alert doesn't spam the channel every poll cycle.
const postedAlerts = new Set();

async function pollAlerts() {
  if (!process.env.ALERT_CHANNEL_ID) return;
  try {
    const res = await fetch(`${BACKEND_URL}/api/alerts`);
    const alerts = await res.json();
    const channel = await client.channels.fetch(process.env.ALERT_CHANNEL_ID);
    for (const alert of alerts) {
      const key = alert.message; // simple dedupe key
      if (postedAlerts.has(key)) continue;
      postedAlerts.add(key);
      const emoji = alert.level === "danger" ? "🚨" : "⚠️";
      const humanized = await humanize(alert.message);
      channel.send(`${emoji} ${humanized}`);
    }
  } catch (err) {
    console.error("pollAlerts failed:", err.message);
  }
}
setInterval(pollAlerts, 60_000); // check once a minute

client.once("ready", () => {
  console.log(`OfficeQuest bot logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
