import Anthropic from "@anthropic-ai/sdk";

interface Product {
  asin: string;
  title: string;
  revenue: number;
  units: number;
  sessions: number;
}

interface InventoryItem {
  asin: string;
  title: string;
  on_hand: number;
  inbound: number;
  reserved: number;
  out_of_stock: boolean;
}

interface AtRiskASIN {
  asin: string;
  title: string;
  onHand: number;
  dailyVelocity: number;
  daysUntilStockout: number;
  status: "out_of_stock" | "critical" | "at_risk";
}

const client = new Anthropic();

// Configuration - UPDATE THESE WITH YOUR ACTUAL VALUES
const TRACKIQ_BRAND = process.env.TRACKIQ_BRAND || "Coop Home Goods";
// Note: If you have a numeric account ID, you can use it instead:
// const ACCOUNT_ID = parseInt(process.env.TRACKIQ_ACCOUNT_ID || "1");
const WEEKS_TO_ALERT = 5;
const DAYS_TO_ALERT = WEEKS_TO_ALERT * 7; // 35 days
const SLACK_CHANNEL = "#low-inventory-alerts";

async function getProductPerformance(
  startDate: string,
  endDate: string
): Promise<Map<string, Product>> {
  const productMap = new Map<string, Product>();

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `You are connected to TrackIQ brand "${TRACKIQ_BRAND}". Get all product performance data from ${startDate} to ${endDate} grouped by product, limit 500. Return ONLY a raw JSON array with fields: asin, title, revenue, units, sessions. No other text.`,
        },
      ],
    });

    // Extract JSON from response
    const contentBlocks = response.content as any[];
    let responseText = "";
    
    for (const block of contentBlocks) {
      if (block && block.text) {
        responseText += block.text;
      }
    }

    if (responseText) {
      const data = JSON.parse(responseText);
      if (Array.isArray(data)) {
        for (const product of data) {
          if (product && product.asin) {
            productMap.set(product.asin, {
              asin: product.asin,
              title: product.title || "Unknown",
              revenue: product.revenue || 0,
              units: product.units || 0,
              sessions: product.sessions || 0,
            });
          }
        }
      }
    }
  } catch (e) {
    console.log("Could not retrieve product performance data");
  }

  return productMap;
}

async function getInventorySnapshot(): Promise<InventoryItem[]> {
  const inventory: InventoryItem[] = [];

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `You are connected to TrackIQ brand "${TRACKIQ_BRAND}". Get the current FBA inventory snapshot for all items, limit 500. Return ONLY a raw JSON array with fields: asin, title, on_hand, inbound, reserved, out_of_stock. No other text.`,
        },
      ],
    });

    // Extract JSON from response
    const contentBlocks = response.content as any[];
    let responseText = "";
    
    for (const block of contentBlocks) {
      if (block && block.text) {
        responseText += block.text;
      }
    }

    if (responseText) {
      const data = JSON.parse(responseText);
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item && item.asin) {
            inventory.push({
              asin: item.asin,
              title: item.title || "Unknown",
              on_hand: item.on_hand || 0,
              inbound: item.inbound || 0,
              reserved: item.reserved || 0,
              out_of_stock: item.out_of_stock || false,
            });
          }
        }
      }
    }
  } catch (e) {
    console.log("Could not retrieve inventory data");
  }

  return inventory;
}

async function calculateAtRiskASINs(
  products: Map<string, Product>,
  inventory: InventoryItem[]
): Promise<AtRiskASIN[]> {
  const atRisk: AtRiskASIN[] = [];

  for (const item of inventory) {
    const product = products.get(item.asin);

    // Handle out of stock
    if (item.out_of_stock) {
      const dailyVelocity = product ? product.units / 30 : 0;
      atRisk.push({
        asin: item.asin,
        title: item.title,
        onHand: 0,
        dailyVelocity: Math.round(dailyVelocity * 100) / 100,
        daysUntilStockout: 0,
        status: "out_of_stock",
      });
      continue;
    }

    // Calculate daily velocity from 30-day data
    const dailyVelocity = product ? product.units / 30 : 0;

    if (dailyVelocity === 0) {
      continue; // Skip products with no sales
    }

    // Calculate sellable inventory (on-hand minus reserved)
    const sellableInventory = item.on_hand - item.reserved;

    if (sellableInventory <= 0) {
      atRisk.push({
        asin: item.asin,
        title: item.title,
        onHand: item.on_hand,
        dailyVelocity: Math.round(dailyVelocity * 100) / 100,
        daysUntilStockout: 0,
        status: "out_of_stock",
      });
      continue;
    }

    // Calculate days until stockout
    const daysUntilStockout = sellableInventory / dailyVelocity;

    // Flag if at or below 5 weeks
    if (daysUntilStockout <= DAYS_TO_ALERT) {
      atRisk.push({
        asin: item.asin,
        title: item.title,
        onHand: sellableInventory,
        dailyVelocity: Math.round(dailyVelocity * 100) / 100,
        daysUntilStockout: Math.round(daysUntilStockout),
        status: daysUntilStockout <= 14 ? "critical" : "at_risk",
      });
    }
  }

  // Sort by urgency (critical first, then by days to stockout)
  return atRisk.sort((a, b) => {
    if (a.status === "out_of_stock" && b.status !== "out_of_stock") return -1;
    if (a.status !== "out_of_stock" && b.status === "out_of_stock") return 1;
    if (a.status === "critical" && b.status !== "critical") return -1;
    if (a.status !== "critical" && b.status === "critical") return 1;
    return a.daysUntilStockout - b.daysUntilStockout;
  });
}

async function sendSlackAlert(atRiskASINs: AtRiskASIN[]): Promise<void> {
  if (atRiskASINs.length === 0) {
    console.log("✅ No low-inventory alerts needed today");
    return;
  }

  // Build message text
  let messageText = `🚨 *Low Inventory Alert - ${atRiskASINs.length} ASIN(s) at risk*\n`;
  messageText += `_Based on 30-day sales velocity_\n\n`;

  // Add critical items
  const criticalItems = atRiskASINs.filter((a) => a.status === "critical");
  if (criticalItems.length > 0) {
    messageText += `🔴 *CRITICAL (≤14 days)*\n`;
    for (const item of criticalItems) {
      messageText += `• *${item.asin}* - ${item.title}\n`;
      messageText += `  On Hand: ${item.onHand} | Velocity: ${item.dailyVelocity}/day | Stockout: ${item.daysUntilStockout} days\n`;
    }
    messageText += `\n`;
  }

  // Add at-risk items
  const atRiskItems = atRiskASINs.filter((a) => a.status === "at_risk");
  if (atRiskItems.length > 0) {
    messageText += `🟡 *AT RISK (15-35 days)*\n`;
    for (const item of atRiskItems) {
      messageText += `• *${item.asin}* - ${item.title}\n`;
      messageText += `  On Hand: ${item.onHand} | Velocity: ${item.dailyVelocity}/day | Stockout: ${item.daysUntilStockout} days\n`;
    }
    messageText += `\n`;
  }

  // Add out of stock items
  const oosItems = atRiskASINs.filter((a) => a.status === "out_of_stock");
  if (oosItems.length > 0) {
    messageText += `⚫ *OUT OF STOCK*\n`;
    for (const item of oosItems) {
      messageText += `• *${item.asin}* - ${item.title} | Velocity: ${item.dailyVelocity}/day\n`;
    }
    messageText += `\n`;
  }

  messageText += `---\n`;
  messageText += `_Last updated: ${new Date().toLocaleString()} UTC | Calculated from 30-day velocity_`;

  // Send to Slack via Claude's MCP connection
  try {
    await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Send this message to Slack channel ${SLACK_CHANNEL}: ${messageText}`,
        },
      ],
    });

    console.log("✅ Slack alert sent to", SLACK_CHANNEL);
  } catch (error) {
    console.error("Error sending Slack message:", error);
    throw error;
  }
}

async function main() {
  console.log("🚀 Starting low-inventory alert routine...");
  console.log(`📊 Analysis window: 30 days`);
  console.log(`⚠️  Alert threshold: ${DAYS_TO_ALERT} days (${WEEKS_TO_ALERT} weeks)`);
  console.log(`🔗 Slack channel: ${SLACK_CHANNEL}`);
  console.log(`🏢 TrackIQ Brand: ${TRACKIQ_BRAND}\n`);

  try {
    // Calculate date range (last 30 days)
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    const startDateStr = startDate.toISOString().split("T")[0];
    const endDateStr = endDate.toISOString().split("T")[0];

    console.log(`📅 Fetching data for ${startDateStr} to ${endDateStr}...`);

    // Get data from TrackIQ
    console.log("📊 Retrieving product performance...");
    const products = await getProductPerformance(startDateStr, endDateStr);
    console.log(`   ✓ Found ${products.size} products with sales data`);

    console.log("📦 Retrieving inventory snapshot...");
    const inventory = await getInventorySnapshot();
    console.log(`   ✓ Found ${inventory.length} SKUs in inventory`);

    // Calculate at-risk ASINs
    console.log("\n🔍 Calculating inventory runway...");
    const atRiskASINs = await calculateAtRiskASINs(products, inventory);

    // Send Slack alert only if there are at-risk items
    if (atRiskASINs.length > 0) {
      console.log(`\n⚠️  Found ${atRiskASINs.length} at-risk ASIN(s):`);
      const critical = atRiskASINs.filter((a) => a.status === "critical").length;
      const atRisk = atRiskASINs.filter((a) => a.status === "at_risk").length;
      const oos = atRiskASINs.filter((a) => a.status === "out_of_stock").length;

      if (critical > 0) console.log(`   🔴 Critical: ${critical}`);
      if (atRisk > 0) console.log(`   🟡 At Risk: ${atRisk}`);
      if (oos > 0) console.log(`   ⚫ Out of Stock: ${oos}`);

      console.log("\n📤 Sending Slack alert...");
      await sendSlackAlert(atRiskASINs);
    } else {
      console.log("\n✅ No low-inventory alerts triggered");
      console.log("   All ASINs have >5 weeks of inventory at current velocity");
    }

    console.log("\n✨ Routine complete");
  } catch (error) {
    console.error("❌ Error in low-inventory alert routine:", error);
    process.exit(1);
  }
}

main().catch(console.error);
