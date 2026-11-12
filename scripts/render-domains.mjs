#!/usr/bin/env node
/**
 * Attach sexychat.fun to astro deploy and optional trigger deploy.
 * Requires: RENDER_API_KEY in the environment (Account Settings → API Keys).
 *
 * Usage:
 *   RENDER_API_KEY=... node scripts/render-domains.mjs
 *   RENDER_API_KEY=... node scripts/render-domains.mjs --apply
 */
const API = "https://api.render.com/v1";
const TARGET_HOST =
  process.env.RENDER_TARGET_HOST || "astro-platform-starter-yjkk.onrender.com";
const DOMAINS = ["sexychat.fun", "www.sexychat.fun"];
const apply = process.argv.includes("--apply");
const deploy = process.argv.includes("--deploy");

const key = process.env.RENDER_API_KEY;
if (!key) {
  console.error("Set RENDER_API_KEY (Render → Account Settings → API Keys)");
  process.exit(1);
}

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(data)}`);
  return data;
}

function serviceHost(svc) {
  return svc?.service?.serviceDetails?.url || svc?.serviceDetails?.url || "";
}

async function listAllServices(cursor = null, out = []) {
  const q = new URLSearchParams({ limit: "100" });
  if (cursor) q.set("cursor", cursor);
  const page = await api(`/services?${q}`);
  for (const row of page) {
    if (row.service) out.push(row);
  }
  const next = page[page.length - 1]?.cursor;
  if (next) return listAllServices(next, out);
  return out;
}

async function listDomains(serviceId) {
  try {
    return await api(`/services/${serviceId}/custom-domains`);
  } catch {
    return [];
  }
}

async function main() {
  const services = await listAllServices();
  const target = services.find(
    (s) =>
      serviceHost(s) === TARGET_HOST ||
      s.service?.name === "astro-platform-starter" ||
      s.service?.name === "astro deploy",
  );
  if (!target) {
    console.error(`No service with host ${TARGET_HOST}. Services:`);
    for (const s of services) {
      console.error(`  - ${s.service?.name} → ${serviceHost(s)} (${s.service?.id})`);
    }
    process.exit(2);
  }
  const targetId = target.service.id;
  console.log(`Target: ${target.service.name} (${targetId}) → ${serviceHost(target)}`);

  for (const s of services) {
    const id = s.service.id;
    const host = serviceHost(s);
    const domains = await listDomains(id);
    for (const d of domains) {
      const name = d.customDomain?.name || d.name;
      if (!DOMAINS.includes(name)) continue;
      console.log(`Found ${name} on ${s.service.name} (${host})`);
      if (id === targetId) continue;
      if (!apply) {
        console.log(`  [dry-run] would remove ${name} from ${id}`);
        continue;
      }
      await api(`/services/${id}/custom-domains/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      console.log(`  Removed ${name} from ${s.service.name}`);
    }
  }

  for (const name of DOMAINS) {
    const onTarget = (await listDomains(targetId)).some(
      (d) => (d.customDomain?.name || d.name) === name,
    );
    if (onTarget) {
      console.log(`Already on target: ${name}`);
      continue;
    }
    if (!apply) {
      console.log(`[dry-run] would add ${name} to ${targetId}`);
      continue;
    }
    await api(`/services/${targetId}/custom-domains`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    console.log(`Added ${name} to target`);
    await api(
      `/services/${targetId}/custom-domains/${encodeURIComponent(name)}/verify`,
      { method: "POST" },
    ).catch(() => {});
  }

  if (deploy && apply) {
    await api(`/services/${targetId}/deploys`, {
      method: "POST",
      body: JSON.stringify({ clearCache: "clear" }),
    });
    console.log("Triggered deploy on astro-platform-starter (clear cache).");
  }

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply [--deploy] to change Render.");
    console.log("\nGoDaddy DNS (www): CNAME www → astro-platform-starter-yjkk.onrender.com");
    console.log("Apex @ → A 216.24.57.1 (unchanged).");
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
