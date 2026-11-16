<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#101b2b">
<title>Home Energy Dashboard</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#101b2b;color:#f4f7fb;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:20px}
header{padding:12px 2px 22px}
h1{font-size:27px;margin:0 0 6px}
.sub{color:#9eafc3;font-size:13px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.card{background:#1b2b40;border:1px solid #30445c;border-radius:17px;padding:17px;min-height:125px}
.card.wide{grid-column:span 2}
.label{font-size:13px;color:#aebed0;margin-bottom:13px}
.value{font-size:29px;font-weight:700;letter-spacing:-1px}
.unit{font-size:14px;color:#aebed0;font-weight:400}
.note{font-size:12px;color:#9eafc3;margin-top:9px}
.status{margin-top:18px;background:#1b2b40;border-radius:14px;padding:15px;color:#aebed0;font-size:13px}
footer{color:#778ba3;font-size:11px;text-align:center;margin:22px 0}
@media(min-width:600px){body{max-width:650px;margin:auto}}
</style>
</head>
<body>
<header>
<h1>Home Energy</h1>
<div class="sub">Fox ESS KH7 · 2 × EP12 · Hypervolt 2</div>
</header>
<div class="grid">
<div class="card">
<div class="label">☀️ Solar generation</div>
<div class="value" id="solar">— <span class="unit">kW</span></div>
<div class="note">Live output</div>
</div>
<div class="card">
<div class="label">🏠 Home consumption</div>
<div class="value" id="home">— <span class="unit">kW</span></div>
<div class="note">Household power</div>
</div>
<div class="card">
<div class="label">🔋 Battery power</div>
<div class="value" id="battery">— <span class="unit">kW</span></div>
<div class="note" id="soc">State of charge: —</div>
</div>
<div class="card">
<div class="label">⚡ Grid power</div>
<div class="value" id="grid">— <span class="unit">kW</span></div>
<div class="note">Import / export</div>
</div>
<div class="card wide">
<div class="label">🚗 Hypervolt EV charging</div>
<div class="value" id="ev">— <span class="unit">kW</span></div>
<div class="note" id="evstatus">Charger status: awaiting connection</div>
</div>
</div>
<div class="status" id="status">Dashboard created. Live data connection not yet configured.</div>
<footer>Personal energy dashboard</footer>

<script>
const FOX_WORKER = "https://energy-api.gerbenbouma.workers.dev/";

function kw(value) {
  return Number(value || 0).toFixed(2);
}

async function loadEnergyData() {
  const status = document.getElementById("status");
  let password = sessionStorage.getItem("energyPassword");

  if (!password) {
    password = prompt("Enter your energy dashboard password");
    if (!password) {
      status.textContent = "Password required.";
      return;
    }
    sessionStorage.setItem("energyPassword", password);
  }

  status.textContent = "Updating Fox ESS readings...";

  try {
    const response = await fetch(FOX_WORKER, {
      headers: { "X-Dashboard-Password": password }
    });

    if (response.status === 401) {
      sessionStorage.removeItem("energyPassword");
      status.textContent = "Password incorrect. Refresh to try again.";
      return;
    }

    const data = await response.json();

    if (!response.ok) throw new Error(JSON.stringify(data));

    const readings = data.result[0].datas;
    const values = {};

    readings.forEach(item => {
      values[item.variable] = item.value;
    });

    const solar = Number(values.pvPower || 0);
    const home = Number(values.loadsPower || 0);
    const charge = Number(values.batChargePower || 0);
    const discharge = Number(values.batDischargePower || 0);
    const soc = Number(values.SoC || 0);
    const gridImport = Number(values.gridConsumptionPower || 0);
    const gridExport = Number(values.feedinPower || 0);

    document.getElementById("solar").innerHTML =
      kw(solar) + ' <span class="unit">kW</span>';

    document.getElementById("home").innerHTML =
      kw(home) + ' <span class="unit">kW</span>';

    document.getElementById("grid").innerHTML =
      kw(Math.max(gridImport, gridExport)) + ' <span class="unit">kW</span>';

    document.getElementById("battery").innerHTML =
      kw(Math.max(charge, discharge)) + ' <span class="unit">kW</span>';

    document.getElementById("soc").textContent =
      "State of charge: " + soc + "%";

    document.getElementById("battery").nextElementSibling.textContent =
      charge > 0.01 ? "Charging" :
      discharge > 0.01 ? "Discharging" : "Standby";

    document.getElementById("grid").nextElementSibling.textContent =
      gridImport > 0.01 ? "Importing from grid" :
      gridExport > 0.01 ? "Exporting to grid" : "No significant grid flow";

    document.getElementById("evstatus").textContent =
      "Hypervolt connection to be added";

    const oldRaw = document.getElementById("foxData");
    if (oldRaw) oldRaw.remove();

    status.textContent =
      "Fox ESS connected · Updated " + data.result[0].time;

  } catch (error) {
    status.textContent = "Update failed: " + error.message;
  }
}

loadEnergyData();
setInterval(loadEnergyData, 300000);
</script>

</body>
</html>
