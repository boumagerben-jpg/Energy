/**
 * Fox ESS read-only API proxy for the Home Energy dashboard.
 * Secrets required in Cloudflare:
 * FOX_API_KEY, FOX_DEVICE_SN, DASHBOARD_PASSWORD
 */

let cachedData = null;
let cachedAt = 0;

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

    if (!env.FOX_API_KEY || !env.FOX_DEVICE_SN || !env.DASHBOARD_PASSWORD) {
      return new Response("Worker secrets are missing", { status: 500, headers: cors });
    }

    if (request.headers.get("X-Dashboard-Password") !== env.DASHBOARD_PASSWORD) {
      return new Response("Incorrect dashboard password", { status: 401, headers: cors });
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
