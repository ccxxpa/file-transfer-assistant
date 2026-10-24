const port = Number(process.env.PORT || 4826);
try {
  const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
    signal: AbortSignal.timeout(3500),
  });
  if (!response.ok || typeof (await response.json()).initialized !== "boolean")
    process.exit(1);
} catch {
  process.exit(1);
}
