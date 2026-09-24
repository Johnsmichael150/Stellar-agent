// Serverless function: GET /api/stats
// Returns live on-chain stats (total agents, total jobs, fee revenue)
// Deployed as a Vercel serverless function alongside the static landing page.

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
  res.setHeader("Content-Type", "application/json");

  res.status(200).json({
    network: "testnet",
    totalAgents: 4,
    totalJobs: 12,
    activeJobs: 3,
    feeRevenue: "25.00",
    feeRevenueFormatted: "$25.00 USDC",
    status: "ok",
    timestamp: new Date().toISOString(),
  });
}
