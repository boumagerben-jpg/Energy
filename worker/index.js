/**
 * Fox ESS read-only API proxy for the Home Energy dashboard.
 * Secrets required in Cloudflare:
 * FOX_API_KEY, FOX_DEVICE_SN, DASHBOARD_PASSWORD
 */

let cachedData = null;
let cachedAt = 0;
let cachedDaily = null;
let cachedDailyAt = 0;
const cachedHistory = new Map();
const FOX_HISTORY_API_PATH = "/op/v0/device/history/query";

function md5(input) {
  const bytes = new TextEncoder().encode(input);
  const length = bytes.length;
  const paddedLength = Math.ceil((length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[length] = 0x80;

  const bitLength = length * 8;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];

  const k = Array.from({ length: 64 }, (_, i) =>
    Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0
  );

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const m = Array.from({ length: 16 }, (_, i) =>
      view.getUint32(offset + i * 4, true)
    );
    let a = a0, b = b0, c = c0, d = d0;

    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const sum = (a + f + k[i] + m[g]) | 0;
      const rotated = (sum << shifts[i]) | (sum >>> (32 - shifts[i]));
      const next = (b + rotated) | 0;
      a = d;
      d = c;
      c = b;
      b = next;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  return [a0, b0, c0, d0].map(n =>
    [0, 8, 16, 24]
      .map(s => ((n >>> s) & 255).toString(16).padStart(2, "0"))
      .join("")
  ).join("");
}


let cachedHypervolt = null;
let hypervoltCachedAt = 0;

async function getHypervoltReading(env) {
  const tokenResponse = await fetch(
    "https://kc.prod.hypervolt.co.uk/realms/retail-customers/protocol/openid-connect/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "home-assistant-hypervolt-charger/2.11.0"
      },
      body: new URLSearchParams({
        client_id: "home-assistant",
        grant_type: "password",
        scope: "openid profile email offline_access",
        username: env.HYPERVOLT_EMAIL,
        password: env.HYPERVOLT_PASSWORD
      })
    }
  );

  if (!tokenResponse.ok) {
    throw new Error("Hypervolt sign-in failed (" + tokenResponse.status + ")");
  }

  const tokenData = await tokenResponse.json();
  const accessToken = tokenData.access_token;
  if (!accessToken) throw new Error("Hypervolt did not return an access token");

  const chargersResponse = await fetch(
    "https://api.hypervolt.co.uk/users/me?includes=chargers",
    {
      headers: {
        "Authorization": "Bearer " + accessToken,
        "User-Agent": "home-assistant-hypervolt-charger/2.11.0"
      }
    }
  );

  if (!chargersResponse.ok) {
    throw new Error("Could not retrieve Hypervolt charger (" + chargersResponse.status + ")");
  }

  const chargersData = await chargersResponse.json();
  const chargers = chargersData.chargers || [];
  if (!chargers.length) throw new Error("No Hypervolt charger found");
  const chargerId = env.HYPERVOLT_CHARGER_ID || chargers[0].id;

  if (!chargers.some(charger => String(charger.id) === String(chargerId))) {
    throw new Error("Configured Hypervolt charger was not found in this account");
  }

  return await new Promise((resolve, reject) => {
    let finished = false;
    let authenticated = false;
    let evPower = null;
    let charging = null;
    let sessionEnergyWh = null;
    let socket;

    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { if (socket && socket.readyState < 2) socket.close(1000, "Reading complete"); } catch {}
      if (error) reject(error);
      else resolve(value);
    };

    const timeout = setTimeout(() => {
      if (evPower !== null || authenticated) {
        finish(null, {
          evPowerW: evPower,
          charging,
          sessionEnergyWh,
          chargerId,
          updatedAt: new Date().toISOString()
        });
      } else {
        finish(new Error("Timed out waiting for Hypervolt data"));
      }
    }, 9000);

    (async () => {
      const wsResponse = await fetch(
        "https://api.hypervolt.co.uk/ws/charger/" + encodeURIComponent(chargerId) + "/sync",
        {
          headers: {
            "Upgrade": "websocket",
            "Origin": "https://hypervolt.co.uk",
            "User-Agent": "home-assistant-hypervolt-charger/2.11.0"
          }
        }
      );

      socket = wsResponse.webSocket;
      if (!socket) {
        throw new Error("Hypervolt did not accept the WebSocket connection");
      }
      socket.accept();

      socket.addEventListener("message", event => {
        try {
          const message = JSON.parse(event.data);
          const method = message.method || "";
          const payload = message.params ?? message.result;

          if (!authenticated && payload && payload.authenticated === true) {
            authenticated = true;
            socket.send(JSON.stringify({
              jsonrpc: "2.0",
              id: "1",
              method: "sync.snapshot"
            }));
            return;
          }

          const inspect = value => {
            if (!value || typeof value !== "object") return;
            if (Object.prototype.hasOwnProperty.call(value, "ev_power")) {
              const n = Number(value.ev_power);
              if (Number.isFinite(n)) evPower = n;
            }
            if (Object.prototype.hasOwnProperty.call(value, "charging")) {
              charging = Boolean(value.charging);
            }
            if (Object.prototype.hasOwnProperty.call(value, "watt_hours")) {
              const n = Number(value.watt_hours);
              if (Number.isFinite(n)) sessionEnergyWh = n;
            }
            if (Array.isArray(value)) value.forEach(inspect);
          };

          inspect(payload);

          if (evPower !== null && (method === "get.session" || method === "sync.apply" || method === "sync.snapshot" || method === "")) {
            finish(null, {
              evPowerW: evPower,
              charging,
              sessionEnergyWh,
              chargerId,
              updatedAt: new Date().toISOString()
            });
          }
        } catch {}
      });

      socket.addEventListener("error", () => {
        finish(new Error("Hypervolt WebSocket connection failed"));
      });

      socket.addEventListener("close", () => {
        if (!finished) {
          if (evPower !== null || authenticated) {
            finish(null, {
              evPowerW: evPower,
              charging,
              sessionEnergyWh,
              chargerId,
              updatedAt: new Date().toISOString()
            });
          } else {
            finish(new Error("Hypervolt WebSocket closed before data arrived"));
          }
        }
      });

      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: "0",
        method: "login",
        params: { token: accessToken, version: 3 }
      }));
    })().catch(finish);
  });
}


function londonDateParts() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const get = type => parts.find(part => part.type === type).value;
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")) };
}


async function queryFoxEnergyReport(env, params) {
  const variable = params.variable || "PVEnergyTotal";
  const reportParams = { ...params };
  delete reportParams.variable;
  const path = "/op/v0/device/report/query";
  const timestamp = Date.now().toString();
  const signature = md5(path + "\r\n" + env.FOX_API_KEY + "\r\n" + timestamp);
  const response = await fetch("https://www.foxesscloud.com" + path, {
    method: "POST",
    headers: {
      token: env.FOX_API_KEY,
      timestamp,
      signature,
      lang: "en",
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0"
    },
    body: JSON.stringify({ sn: env.FOX_DEVICE_SN, ...reportParams, variables: [variable] })
  });
  const result = await response.json();
  if (!response.ok || result.errno !== 0) {
    throw new Error("Fox ESS historical report failed: " + JSON.stringify(result));
  }
  const item = (result.result || []).find(entry => String(entry.variable || "").toLowerCase() === variable.toLowerCase());
  if (!item || !Array.isArray(item.values)) {
    throw new Error("Fox ESS historical report did not include " + variable + " values. Returned: " + (result.result || []).map(entry => entry.variable).join(", "));
  }
  return item.values.map(value => {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  });
}


async function queryFoxGridEnergyReport(env, year, month) {
  const variables = ["gridConsumption", "feedin"];
  const path = "/op/v0/device/report/query";
  const timestamp = Date.now().toString();
  const signature = md5(path + "\r\n" + env.FOX_API_KEY + "\r\n" + timestamp);
  const response = await fetch("https://www.foxesscloud.com" + path, {
    method: "POST",
    headers: {
      token: env.FOX_API_KEY, timestamp, signature, lang: "en",
      "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"
    },
    body: JSON.stringify({ sn: env.FOX_DEVICE_SN, year, month, dimension: "month", variables }),
    signal: AbortSignal.timeout(12000)
  });
  const result = await response.json();
  if (!response.ok || result.errno !== 0) {
    throw new Error("Fox ESS grid report failed: " + JSON.stringify(result));
  }
  const output = {};
  for (const variable of variables) {
    const item = (result.result || []).find(entry => String(entry.variable || "").toLowerCase() === variable.toLowerCase());
    if (!item || !Array.isArray(item.values)) {
      throw new Error("Fox ESS grid report did not include " + variable + ". Returned: " + (result.result || []).map(entry => entry.variable).join(", "));
    }
    output[variable] = item.values.map(value => {
      if (value == null) return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    });
  }
  return output;
}

async function getFoxGridHistoryReport(env, date, dimension) {
  const [year, month, day] = date.split("-").map(Number);
  if (dimension === "year") {
    const reports = await Promise.all(Array.from({ length: 12 }, (_, i) => queryFoxGridEnergyReport(env, year, i + 1)));
    return {
      dimension, date,
      importValues: reports.map(r => r.gridConsumption.reduce((sum, v) => sum + (v == null ? 0 : v), 0)),
      exportValues: reports.map(r => r.feedin.reduce((sum, v) => sum + (v == null ? 0 : v), 0)),
      updatedAt: new Date().toISOString()
    };
  }
  if (dimension === "week") {
    const start = new Date(Date.UTC(year, month - 1, day));
    const dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start); d.setUTCDate(d.getUTCDate() + i);
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    });
    const keys = [...new Set(dates.map(d => d.year + "-" + d.month))];
    const reports = await Promise.all(keys.map(async key => {
      const [y, m] = key.split("-").map(Number);
      return [key, await queryFoxGridEnergyReport(env, y, m)];
    }));
    const byMonth = new Map(reports);
    return {
      dimension, date,
      importValues: dates.map(d => byMonth.get(d.year + "-" + d.month).gridConsumption[d.day - 1] ?? null),
      exportValues: dates.map(d => byMonth.get(d.year + "-" + d.month).feedin[d.day - 1] ?? null),
      updatedAt: new Date().toISOString()
    };
  }
  const report = await queryFoxGridEnergyReport(env, year, month);
  return { dimension, date, importValues: report.gridConsumption, exportValues: report.feedin, updatedAt: new Date().toISOString() };
}

async function getFoxHistoryReport(env, date, dimension, variable = "PVEnergyTotal") {
  const [year, month, day] = date.split("-").map(Number);
  let values;
  if (dimension === "week") {
    // Build the seven daily bars from the same monthly report data that powers
    // the working month chart. Fox's weekly report can return an empty series
    // for some devices despite a successful API response.
    const start = new Date(Date.UTC(year, month - 1, day));
    const dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    });
    const monthKeys = [...new Set(dates.map(d => d.year + "-" + d.month))];
    const reports = await Promise.all(monthKeys.map(async key => {
      const [reportYear, reportMonth] = key.split("-").map(Number);
      return [key, await queryFoxEnergyReport(env, { year: reportYear, month: reportMonth, dimension: "month", variable })];
    }));
    const byMonth = new Map(reports);
    values = dates.map(d => {
      const series = byMonth.get(d.year + "-" + d.month) || [];
      return series[d.day - 1] ?? null;
    });
  } else if (dimension === "year") {
    // Build monthly totals from the daily values returned by each monthly report.
    values = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const series = await queryFoxEnergyReport(env, { year, month: i + 1, dimension: "month", variable });
      return series.reduce((sum, value) => sum + (value == null ? 0 : value), 0);
    }));
  } else {
    values = await queryFoxEnergyReport(env, { year, month, dimension: "month", variable });
  }
  return { dimension, date, variable, values, updatedAt: new Date().toISOString() };
}

async function queryFoxBatteryEnergyReport(env, year, month, dimension) {
  const variables = ["chargeEnergyTotal", "dischargeEnergyTotal", "PVEnergyTotal", "loads", "feedin"];
  const path = "/op/v0/device/report/query";
  const timestamp = Date.now().toString();
  const signature = md5(path + "\r\n" + env.FOX_API_KEY + "\r\n" + timestamp);
  const params = { sn: env.FOX_DEVICE_SN, year, dimension, variables };
  if (dimension === "month") params.month = month;
  const response = await fetch("https://www.foxesscloud.com" + path, {
    method: "POST",
    headers: { token: env.FOX_API_KEY, timestamp, signature, lang: "en", "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json();
  if (!response.ok || result.errno !== 0) throw new Error("Fox ESS battery energy report failed: " + JSON.stringify(result));
  const output = {};
  for (const variable of variables) {
    const item = (result.result || []).find(entry => String(entry.variable || "").toLowerCase() === variable.toLowerCase());
    if (!item || !Array.isArray(item.values)) throw new Error("Fox ESS report omitted " + variable);
    output[variable] = item.values.map(value => value == null ? null : Number(value));
  }
  return output;
}

async function getFoxBatteryEnergyHistory(env, date, dimension) {
  const [year, month] = date.split("-").map(Number);
  const report = await queryFoxBatteryEnergyReport(env, year, month, dimension);
  const chargeValues = report.chargeEnergyTotal;
  const dischargeValues = report.dischargeEnergyTotal;
  const solarValues = chargeValues.map((charge, i) => {
    if (charge == null) return null;
    const pv = report.PVEnergyTotal[i], loads = report.loads[i], feedin = report.feedin[i];
    if (pv == null || loads == null || feedin == null) return null;
    return Math.min(Math.max(0, charge), Math.max(0, pv - loads - feedin));
  });
  return { dimension, date, chargeValues, dischargeValues, solarValues, updatedAt: new Date().toISOString() };
}

async function getFoxDailyReport(env) {
  const { year, month, day } = londonDateParts();
  const path = "/op/v0/device/report/query";
  const timestamp = Date.now().toString();
  const signature = md5(path + "\r\n" + env.FOX_API_KEY + "\r\n" + timestamp);
  const response = await fetch("https://www.foxesscloud.com" + path, {
    method: "POST",
    headers: {
      token: env.FOX_API_KEY,
      timestamp,
      signature,
      lang: "en",
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0"
    },
    body: JSON.stringify({
      sn: env.FOX_DEVICE_SN,
      year,
      month,
      day,
      dimension: "day",
      variables: ["PVEnergyTotal", "gridConsumption", "feedin"]
    })
  });
  const result = await response.json();
  if (!response.ok || result.errno !== 0) {
    throw new Error("Fox ESS daily report failed: " + JSON.stringify(result));
  }
  const totals = {};
  for (const item of result.result || []) {
    const values = Array.isArray(item.values) ? item.values : [];
    totals[item.variable] = values.reduce((sum, value) => sum + Number(value || 0), 0);
  }
  return {
    date: year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0"),
    solarKWh: totals.PVEnergyTotal ?? null,
    gridImportKWh: totals.gridConsumption ?? null,
    gridExportKWh: totals.feedin ?? null,
    updatedAt: new Date().toISOString()
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = /^https:\/\/[a-zA-Z0-9-]+\.github\.io$/.test(origin);

    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : "null",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "X-Dashboard-Password",
      "Vary": "Origin"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    if (!allowed) {
      return new Response("Origin not allowed", { status: 403, headers: cors });
    }

    const url = new URL(request.url);
    const isHypervolt = url.pathname === "/hypervolt";
    const isDaily = url.pathname === "/daily";
    const isHistory = url.pathname === "/history";

    if (!env.DASHBOARD_PASSWORD) {
      return new Response("Worker secrets are missing", { status: 500, headers: cors });
    }
    if (isHypervolt && (!env.HYPERVOLT_EMAIL || !env.HYPERVOLT_PASSWORD)) {
      return new Response("Hypervolt secrets are missing", { status: 500, headers: cors });
    }
    if (!isHypervolt && (!env.FOX_API_KEY || !env.FOX_DEVICE_SN)) {
      return new Response("Fox ESS secrets are missing", { status: 500, headers: cors });
    }

    if (request.headers.get("X-Dashboard-Password") !== env.DASHBOARD_PASSWORD) {
      return new Response("Incorrect dashboard password", { status: 401, headers: cors });
    }



    if (url.pathname === "/battery-energy-history") {
      const dimension = url.searchParams.get("dimension") || "month";
      const date = url.searchParams.get("date") || "";
      if (!["month", "year"].includes(dimension) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + "T12:00:00Z"))) {
        return new Response(JSON.stringify({ error: "Invalid battery energy report period" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
      }
      const cacheKey = "battery-energy:" + dimension + ":" + date;
      const cached = cachedHistory.get(cacheKey);
      if (cached && Date.now() - cached.at < 900000) return new Response(JSON.stringify(cached.data), { headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
      try {
        const history = await getFoxBatteryEnergyHistory(env, date, dimension);
        cachedHistory.set(cacheKey, { data: history, at: Date.now() });
        return new Response(JSON.stringify(history), { headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
      } catch (error) {
        return new Response(JSON.stringify({ error: "Fox ESS battery energy report failed", details: error.message }), { status: 502, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
      }
    }

    if (url.pathname === "/battery-history-range") {
      const startDate = url.searchParams.get("start");
      const endDate = url.searchParams.get("end");
      const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") && Number.isFinite(Date.parse(value + "T12:00:00Z"));
      if (!validDate(startDate) || !validDate(endDate) || endDate <= startDate) {
        return new Response(JSON.stringify({ error: "Invalid battery history range" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
      }
      const days = (Date.parse(endDate + "T12:00:00Z") - Date.parse(startDate + "T12:00:00Z")) / 86400000;
      if (days > 367) return new Response(JSON.stringify({ error: "Battery history range is too large" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
      const cacheKey = "battery-range:" + startDate + ":" + endDate;
      const cached = cachedHistory.get(cacheKey);
      if (cached && Date.now() - cached.at < 900000) return new Response(JSON.stringify(cached.data), { headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
      try {
        const offsetMinutes = value => {
          const zone = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "shortOffset" }).formatToParts(new Date(value + "T12:00:00Z")).find(part => part.type === "timeZoneName")?.value || "GMT";
          const match = zone.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
          if (!match) return 0;
          const amount = Number(match[2]) * 60 + Number(match[3] || 0);
          return match[1] === "+" ? amount : -amount;
        };
        const localMidnightMs = value => Date.parse(value + "T00:00:00Z") - offsetMinutes(value) * 60000;
        const rangeStartMs = localMidnightMs(startDate);
        const rangeEndMs = localMidnightMs(endDate);
        const series = {};
        let cursorMs = rangeStartMs;
        while (cursorMs < rangeEndMs) {
          const nextMs = Math.min(cursorMs + 24 * 60 * 60 * 1000, rangeEndMs);
          const timestamp = Date.now().toString();
          const signature = md5(FOX_HISTORY_API_PATH + "\r\n" + env.FOX_API_KEY + "\r\n" + timestamp);
          const response = await fetch("https://www.foxesscloud.com" + FOX_HISTORY_API_PATH, {
            method: "POST",
            headers: { token: env.FOX_API_KEY, timestamp, signature, lang: "en", "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
            body: JSON.stringify({ sn: env.FOX_DEVICE_SN, begin: cursorMs, end: nextMs, variables: ["pvPower", "loadsPower", "feedinPower", "batChargePower", "batDischargePower"] }),
            signal: AbortSignal.timeout(25000)
          });
          const result = await response.json();
          if (!response.ok || result.errno !== 0) throw new Error(JSON.stringify(result));
          for (const device of result.result || []) for (const item of device.datas || []) {
            if (!series[item.variable]) series[item.variable] = [];
            series[item.variable].push(...(item.data || []).map(point => ({ time: point.time, value: Number(point.value) })).filter(point => Number.isFinite(point.value)));
          }
          cursorMs = nextMs;
          if (cursorMs < rangeEndMs) await new Promise(resolve => setTimeout(resolve, 1100));
        }
        const data = { start: startDate, end: endDate, series, updatedAt: new Date().toISOString() };
        cachedHistory.set(cacheKey, { data, at: Date.now() });
        return new Response(JSON.stringify(data), { headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
      } catch (error) {
        return new Response(JSON.stringify({ error: "Fox ESS battery power history failed", details: error.message }), { status: 502, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
      }
    }

    if (url.pathname === "/battery-history") {
      const date = url.searchParams.get("date") || (() => {
        const d = londonDateParts();
        return d.year + "-" + String(d.month).padStart(2, "0") + "-" + String(d.day).padStart(2, "0");
      })();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + "T12:00:00Z"))) {
        return new Response(JSON.stringify({ error: "Invalid battery history date" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
      }
      const cacheKey = "battery-day:" + date;
      const cached = cachedHistory.get(cacheKey);
      if (cached && Date.now() - cached.at < 900000) return new Response(JSON.stringify(cached.data), { headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
      try {
        const nextDate = new Date(Date.parse(date + "T12:00:00Z") + 86400000).toISOString().slice(0, 10);
        const offsetMinutes = value => {
          const zone = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Europe/London", timeZoneName: "shortOffset"
          }).formatToParts(new Date(value + "T12:00:00Z")).find(part => part.type === "timeZoneName")?.value || "GMT";
          const match = zone.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
          if (!match) return 0;
          const amount = Number(match[2]) * 60 + Number(match[3] || 0);
          return match[1] === "+" ? amount : -amount;
        };
        const begin = (Date.parse(date + "T00:00:00Z") - offsetMinutes(date) * 60000) * 1000;
        const end = (Date.parse(nextDate + "T00:00:00Z") - offsetMinutes(nextDate) * 60000) * 1000;
        const timestamp = Date.now().toString();
        const signature = md5(FOX_HISTORY_API_PATH + "\r\n" + env.FOX_API_KEY + "\r\n" + timestamp);
        const response = await fetch("https://www.foxesscloud.com" + FOX_HISTORY_API_PATH, {
          method: "POST",
          headers: { token: env.FOX_API_KEY, timestamp, signature, lang: "en", "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
          body: JSON.stringify({ sn: env.FOX_DEVICE_SN, begin, end, variables: ["pvPower", "loadsPower", "feedinPower", "gridConsumptionPower", "batChargePower", "batDischargePower", "SoC"] }),
          signal: AbortSignal.timeout(20000)
        });
        const result = await response.json();
        if (!response.ok || result.errno !== 0) throw new Error(JSON.stringify(result));
        const series = {};
        for (const device of result.result || []) for (const item of device.datas || []) {
          series[item.variable] = (item.data || []).map(point => ({ time: point.time, value: Number(point.value) })).filter(point => Number.isFinite(point.value));
        }
        const data = { date, series, updatedAt: new Date().toISOString() };
        cachedHistory.set(cacheKey, { data, at: Date.now() });
        return new Response(JSON.stringify(data), { headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
      } catch (error) {
        return new Response(JSON.stringify({ error: "Fox ESS battery history failed", details: error.message }), { status: 502, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
      }
    }

    if (url.pathname === "/grid-history") {
      const dimension = url.searchParams.get("dimension") || "week";
      const date = url.searchParams.get("date") || (() => {
        const d = londonDateParts();
        return d.year + "-" + String(d.month).padStart(2, "0") + "-" + String(d.day).padStart(2, "0");
      })();
      if (!["week", "month", "year"].includes(dimension) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !Number.isFinite(Date.parse(date + "T12:00:00Z"))) {
        return new Response(JSON.stringify({ error: "Invalid grid history period" }), {
          status: 400, headers: { ...cors, "Content-Type": "application/json" }
        });
      }
      const cacheKey = "grid:" + dimension + ":" + date;
      const cached = cachedHistory.get(cacheKey);
      if (cached && Date.now() - cached.at < 900000) {
        return new Response(JSON.stringify(cached.data), {
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      }
      try {
        const history = await getFoxGridHistoryReport(env, date, dimension);
        cachedHistory.set(cacheKey, { data: history, at: Date.now() });
        return new Response(JSON.stringify(history), {
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: "Fox ESS grid history failed", details: error.message }), {
          status: 502, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      }
    }

    if (isHistory) {
      const dimension = url.searchParams.get("dimension") || "week";
      const date = url.searchParams.get("date") || londonDateParts().year + "-" +
        String(londonDateParts().month).padStart(2, "0") + "-" +
        String(londonDateParts().day).padStart(2, "0");
      if (!["week", "month", "year"].includes(dimension) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !Number.isFinite(Date.parse(date + "T12:00:00Z"))) {
        return new Response(JSON.stringify({ error: "Invalid history period" }), {
          status: 400, headers: { ...cors, "Content-Type": "application/json" }
        });
      }
      const variable = url.searchParams.get("variable") || "PVEnergyTotal";
      if (!["PVEnergyTotal", "gridConsumption", "feedin", "chargeEnergyTotal", "dischargeEnergyTotal"].includes(variable)) {
        return new Response(JSON.stringify({ error: "Invalid history variable" }), {
          status: 400, headers: { ...cors, "Content-Type": "application/json" }
        });
      }
      const cacheKey = dimension + ":" + date + ":" + variable;
      const cached = cachedHistory.get(cacheKey);
      if (cached && Date.now() - cached.at < 900000) {
        return new Response(JSON.stringify(cached.data), {
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      }
      try {
        const history = await getFoxHistoryReport(env, date, dimension, variable);
        cachedHistory.set(cacheKey, { data: history, at: Date.now() });
        return new Response(JSON.stringify(history), {
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          error: "Fox ESS historical report failed",
          details: error.message
        }), {
          status: 502, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      }
    }

    if (isDaily) {
      if (cachedDaily && Date.now() - cachedDailyAt < 900000) {
        return new Response(JSON.stringify(cachedDaily), {
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      }
      try {
        const daily = await getFoxDailyReport(env);
        cachedDaily = daily;
        cachedDailyAt = Date.now();
        return new Response(JSON.stringify(daily), {
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          error: "Fox ESS daily report failed",
          details: error.message
        }), {
          status: 502,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      }
    }

    if (isHypervolt) {
      if (cachedHypervolt && Date.now() - hypervoltCachedAt < 300000) {
        return new Response(JSON.stringify(cachedHypervolt), {
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      }
      try {
        const reading = await getHypervoltReading(env);
        cachedHypervolt = reading;
        hypervoltCachedAt = Date.now();
        return new Response(JSON.stringify(reading), {
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          error: "Hypervolt connection failed",
          details: error.message
        }), {
          status: 502,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      }
    }

    if (cachedData && Date.now() - cachedAt < 300000) {
      return new Response(JSON.stringify(cachedData), {
        headers: {
          ...cors,
          "Content-Type": "application/json",
          "Cache-Control": "no-store"
        }
      });
    }

    const path = "/op/v1/device/real/query";
    const timestamp = Date.now().toString();
    const signature = md5(path + "\r\n" + env.FOX_API_KEY + "\r\n" + timestamp);

    try {
      const foxResponse = await fetch("https://www.foxesscloud.com" + path, {
        method: "POST",
        headers: {
          "token": env.FOX_API_KEY,
          "timestamp": timestamp,
          "signature": signature,
          "lang": "en",
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0"
        },
        body: JSON.stringify({ sns: [env.FOX_DEVICE_SN] })
      });

      const result = await foxResponse.json();

      if (!foxResponse.ok || result.errno !== 0) {
        return new Response(JSON.stringify({
          error: "Fox ESS API error",
          details: result
        }), {
          status: 502,
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }

      cachedData = result;
      cachedAt = Date.now();

      return new Response(JSON.stringify(result), {
        headers: {
          ...cors,
          "Content-Type": "application/json",
          "Cache-Control": "no-store"
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({
        error: "Connection failed",
        details: error.message
      }), {
        status: 502,
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }
  }
};
