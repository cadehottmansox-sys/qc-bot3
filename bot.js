require("dotenv/config");
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, SlashCommandBuilder
} = require("discord.js");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const QUALITY_CHANNEL = "1483823433908486285";
const HISTORY_FILE = path.join(__dirname, "score_history.json");
const dashboardSessions = new Map();

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); }
  catch { return []; }
}
function saveHistory(entry) {
  const history = loadHistory();
  history.unshift(entry);
  if (history.length > 500) history.length = 500;
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function fetchImageAsBase64(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    protocol.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return fetchImageAsBase64(res.headers.location).then(resolve).catch(reject);
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const rawType = (res.headers["content-type"] || "image/jpeg").split(";")[0].trim().toLowerCase();
        const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
        const mediaType = allowed.includes(rawType) ? rawType : "image/jpeg";
        resolve({ b64: buf.toString("base64"), mediaType });
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function findAuthenticImage(repImages) {
  const contentParts = [];
  repImages.forEach((img, i) => {
    contentParts.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.b64 } });
    contentParts.push({ type: "text", text: "Image " + (i + 1) + " of " + repImages.length + " — same product, different angle." });
  });
  contentParts.push({ type: "text", text: "Using all images above, identify the REAL authentic brand/product and find authentic reference image URLs." });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    system: `You are a JSON-only product identification API. Identify the AUTHENTIC BRAND of the product — ignore any replica/1688 branding. Look at logos, design, colorway to identify the real brand.

Respond with ONLY raw JSON. No words before or after. No markdown.

{"productName":"exact authentic product name and colorway","brand":"real brand name","searchQuery":"search query used","authenticImageUrl":"direct CDN image URL ending in .jpg .png or .webp","authenticImageUrl2":"second fallback CDN URL","source":"site name"}

Rules:
- Identify REAL brand (Alo Yoga, Nike, Supreme etc) not fake names
- Find real direct CDN image URLs from cdn.shopify.com, images.stockx.com, media.goat.com, or official brand sites
- URLs must end in .jpg, .png, or .webp
- Entire response must be valid JSON starting with { and ending with }`,
    messages: [{ role: "user", content: contentParts }]
  });

  const textBlock = response.content.find(b => b.type === "text");
  if (!textBlock) throw new Error("No identification response");
  const match = textBlock.text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in response: " + textBlock.text.slice(0, 120));
  return JSON.parse(match[0]);
}

async function scoreQuality(repImages, productInfo) {
  const contentParts = [];
  repImages.forEach((img) => {
    contentParts.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.b64 } });
  });
  contentParts.push({ type: "text", text: "These are " + repImages.length + " image(s) of a 1688/replica product identified as: " + productInfo.productName + " by " + productInfo.brand + ". Use web search to find authentic reference images of this product, then compare and score the replica." });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    system: `You are an expert authenticator for replica products. You will receive replica image(s) and a product name. Use web search to find authentic reference images of the product, then compare and score the replica.

Return ONLY valid JSON (no markdown):
{
  "overallScore": <0-100>,
  "grade": "<S|A|B|C|D|F>",
  "verdict": "<one punchy sentence>",
  "categories": {
    "stitching":       { "score": <0-10>, "note": "<10 words max>" },
    "materials":       { "score": <0-10>, "note": "<10 words max>" },
    "colorAccuracy":   { "score": <0-10>, "note": "<10 words max>" },
    "logoPlacement":   { "score": <0-10>, "note": "<10 words max>" },
    "hardwareQuality": { "score": <0-10>, "note": "<10 words max>" },
    "overallFinish":   { "score": <0-10>, "note": "<10 words max>" }
  },
  "redFlags": ["<issue>", "<issue>"],
  "greenFlags": ["<strength>", "<strength>"],
  "buyRecommendation": "<Yes / No / Maybe — one sentence reason>"
}`,
    messages: [{ role: "user", content: contentParts }]
  });

  const textBlock = response.content.find(b => b.type === "text");
  if (!textBlock) throw new Error("No scoring response");
  const match = textBlock.text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in score response: " + textBlock.text.slice(0, 120));
  return JSON.parse(match[0]);
}

function buildDashboardEmbed(session) {
  const hasRep = !!(session?.repUrl || session?.repUrls?.length);
  const hasAuth = !!session?.authUrl;
  const repCount = session?.repUrls?.length || (hasRep ? 1 : 0);
  return new EmbedBuilder()
    .setColor(0x111111)
    .setTitle("🔬 QC Dashboard")
    .setDescription("Upload your images using the buttons below, then hit **Run Analysis**.")
    .addFields(
      { name: "📦 Slot 1 — 1688 / Replica Image", value: hasRep ? "✅ " + repCount + " image(s) uploaded" : "⬜ Not uploaded yet — click the button below", inline: false },
      { name: "🏷️ Slot 2 — Authentic Reference *(optional)*", value: hasAuth ? "✅ Image uploaded" : "⬜ Skip this — bot will find the authentic image automatically", inline: false }
    )
    .setFooter({ text: "Rep Quality Bot · #quality-control" })
    .setTimestamp();
}

function buildDashboardButtons(session) {
  const hasRep = !!(session?.repUrl || session?.repUrls?.length);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dash_upload_rep").setLabel(hasRep ? "📦 Re-upload 1688 Image" : "📦 Upload 1688 Image").setStyle(hasRep ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("dash_upload_auth").setLabel(session?.authUrl ? "🏷️ Re-upload Authentic" : "🏷️ Upload Authentic (optional)").setStyle(session?.authUrl ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("dash_run").setLabel("⚡ Run Analysis").setStyle(ButtonStyle.Danger).setDisabled(!hasRep),
    new ButtonBuilder().setCustomId("dash_clear").setLabel("🗑️ Clear").setStyle(ButtonStyle.Secondary)
  );
}

function buildResultEmbed(productInfo, result, username, repImageUrl) {
  const gradeEmoji = { S: "💎", A: "✅", B: "🔵", C: "🟡", D: "🟠", F: "🔴" };
  const gradeColor = { S: 0x00c853, A: 0x1565c0, B: 0x6a1b9a, C: 0xf9a825, D: 0xe64a19, F: 0x424242 };
  const scoreBar = (score, max) => {
    max = max || 10;
    const filled = Math.round((score / max) * 8);
    return "█".repeat(filled) + "░".repeat(8 - filled) + " " + score + "/" + max;
  };
  const cats = result.categories;
  const embed = new EmbedBuilder()
    .setColor(gradeColor[result.grade] || 0x888888)
    .setTitle((gradeEmoji[result.grade] || "📊") + " " + productInfo.productName)
    .setDescription("**" + result.verdict + "**")
    .addFields(
      { name: "Overall Score: " + result.overallScore + "/100 · Grade: " + result.grade, value: scoreBar(result.overallScore, 100), inline: false },
      {
        name: "📋 Category Breakdown",
        value: [
          "**Stitching**      " + scoreBar(cats.stitching.score) + " — " + cats.stitching.note,
          "**Materials**      " + scoreBar(cats.materials.score) + " — " + cats.materials.note,
          "**Color**          " + scoreBar(cats.colorAccuracy.score) + " — " + cats.colorAccuracy.note,
          "**Logo**           " + scoreBar(cats.logoPlacement.score) + " — " + cats.logoPlacement.note,
          "**Hardware**       " + scoreBar(cats.hardwareQuality.score) + " — " + cats.hardwareQuality.note,
          "**Finish**         " + scoreBar(cats.overallFinish.score) + " — " + cats.overallFinish.note,
        ].join("\n"),
        inline: false,
      },
      { name: "✅ Green Flags", value: result.greenFlags.map(f => "• " + f).join("\n") || "None", inline: true },
      { name: "🚩 Red Flags", value: result.redFlags.map(f => "• " + f).join("\n") || "None", inline: true },
      { name: "🛒 Buy Recommendation", value: result.buyRecommendation, inline: false },
      { name: "🔍 Authentic Reference", value: "Found on: " + productInfo.source, inline: false }
    )
    .setFooter({ text: "Requested by " + username + " · Rep Quality Bot" })
    .setTimestamp();
  if (repImageUrl) embed.setThumbnail(repImageUrl);
  return embed;
}

async function runAnalysis(interaction, repUrls, repUrl, authUrl, username) {
  try {
    const allRepUrls = repUrls || [repUrl];
    const repImages = await Promise.all(allRepUrls.map(url => fetchImageAsBase64(url)));

    let productInfo;
    try {
      productInfo = await findAuthenticImage(repImages);
    } catch (e) {
      console.error("findAuthenticImage error:", e);
      return interaction.editReply({ content: "❌ Couldn't identify the product: `" + e.message + "`", embeds: [], components: [] });
    }

    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x111111).setTitle("🔬 Analyzing...").setDescription("🌐 **Step 2/3** — Found **" + productInfo.productName + "** · Fetching authentic image...")],
      components: [],
    });

    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x111111).setTitle("🔬 Analyzing...").setDescription("⚖️ **Step 3/3** — Scoring **" + productInfo.productName + "** across " + repImages.length + " image(s)...")],
      components: [],
    });

    const result = await scoreQuality(repImages, productInfo);
    const embed = buildResultEmbed(productInfo, result, username, repUrl || allRepUrls[0]);

    saveHistory({
      timestamp: new Date().toISOString(),
      guildId: interaction.guildId,
      guildName: interaction.guild?.name,
      userId: interaction.user.id,
      username,
      productName: productInfo.productName,
      brand: productInfo.brand,
      overallScore: result.overallScore,
      grade: result.grade,
      verdict: result.verdict,
      buyRecommendation: result.buyRecommendation,
      imageUrl: repUrl || allRepUrls[0],
    });

    await interaction.editReply({ content: "", embeds: [embed], components: [] });

  } catch (err) {
    console.error("runAnalysis error:", err);
    await interaction.editReply({ content: "❌ Something went wrong: `" + err.message + "`", embeds: [], components: [] });
  }
}

client.once("ready", async () => {
  console.log("✅ Rep Quality Bot online as " + client.user.tag);
  const commands = [
    new SlashCommandBuilder().setName("dashboard").setDescription("Open the QC dashboard — upload images and run analysis"),
    new SlashCommandBuilder().setName("quality").setDescription("Quick score — attach your 1688 image directly")
      .addAttachmentOption(opt => opt.setName("image").setDescription("Your 1688 / replica image").setRequired(true)),
    new SlashCommandBuilder().setName("history").setDescription("View recent quality scores in this server")
      .addIntegerOption(opt => opt.setName("count").setDescription("How many to show (default 5, max 10)").setRequired(false)),
  ];
  try {
    await client.application.commands.set(commands);
    console.log("✅ Slash commands registered");
  } catch (e) {
    console.error("Failed to register commands:", e);
  }
});

client.on("interactionCreate", async (interaction) => {

  if (interaction.isChatInputCommand() && interaction.commandName === "dashboard") {
    if (interaction.channelId !== QUALITY_CHANNEL)
      return interaction.reply({ content: "❌ Use this in <#" + QUALITY_CHANNEL + "> only.", flags: 64 });
    const session = { repUrl: null, repUrls: null, authUrl: null, waitingFor: null };
    dashboardSessions.set(interaction.user.id, session);
    await interaction.reply({ embeds: [buildDashboardEmbed(session)], components: [buildDashboardButtons(session)] });
    const msg = await interaction.fetchReply();
    session.messageId = msg.id;
  }

  if (interaction.isButton()) {
    const userId = interaction.user.id;
    const session = dashboardSessions.get(userId);
    if (!session && interaction.customId.startsWith("dash_"))
      return interaction.reply({ content: "❌ Session expired. Run `/dashboard` again.", flags: 64 });

    if (interaction.customId === "dash_upload_rep" || interaction.customId === "dash_upload_auth") {
      session.waitingFor = interaction.customId === "dash_upload_rep" ? "rep" : "auth";
      const slot = session.waitingFor === "rep" ? "1688/replica" : "authentic reference";
      return interaction.reply({ content: "📎 Send your **" + slot + "** image(s) as a message in this channel right now.", flags: 64 });
    }

    if (interaction.customId === "dash_clear") {
      session.repUrl = null; session.repUrls = null; session.authUrl = null; session.waitingFor = null;
      return interaction.update({ embeds: [buildDashboardEmbed(session)], components: [buildDashboardButtons(session)] });
    }

    if (interaction.customId === "dash_run") {
      if (!session?.repUrl && !session?.repUrls?.length)
        return interaction.reply({ content: "❌ Upload the 1688 image first.", flags: 64 });
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(0x111111).setTitle("🔬 Analyzing...").setDescription("🔍 **Step 1/3** — Identifying product...")],
        components: [],
      });
      await runAnalysis(interaction, session.repUrls, session.repUrl, session.authUrl, interaction.user.username);
      dashboardSessions.delete(userId);
    }
  }

  if (interaction.isChatInputCommand() && interaction.commandName === "quality") {
    if (interaction.channelId !== QUALITY_CHANNEL)
      return interaction.reply({ content: "❌ Use this in <#" + QUALITY_CHANNEL + "> only.", flags: 64 });
    await interaction.deferReply();
    const attachment = interaction.options.getAttachment("image");
    if (!attachment || !attachment.contentType?.startsWith("image/"))
      return interaction.editReply("❌ Please attach a valid image.");
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x111111).setTitle("🔬 Analyzing...").setDescription("🔍 **Step 1/3** — Identifying product...")] });
    await runAnalysis(interaction, [attachment.url], attachment.url, null, interaction.user.username);
  }

  if (interaction.isChatInputCommand() && interaction.commandName === "history") {
    if (interaction.channelId !== QUALITY_CHANNEL)
      return interaction.reply({ content: "❌ Use this in <#" + QUALITY_CHANNEL + "> only.", flags: 64 });
    const count = Math.min(interaction.options.getInteger("count") || 5, 10);
    const history = loadHistory().filter(e => e.guildId === interaction.guildId);
    if (history.length === 0)
      return interaction.reply("📭 No scores yet. Use `/dashboard` or `/quality` to get started!");
    const gradeEmoji = { S: "💎", A: "✅", B: "🔵", C: "🟡", D: "🟠", F: "🔴" };
    const embed = new EmbedBuilder()
      .setColor(0x1a1a1a)
      .setTitle("📊 Recent Quality Scores")
      .setDescription(history.slice(0, count).map((e, i) => {
        const date = new Date(e.timestamp).toLocaleDateString();
        return "**" + (i+1) + ".** " + (gradeEmoji[e.grade] || "📊") + " **" + e.productName + "** — " + e.overallScore + "/100 (" + e.grade + ")\n   by @" + e.username + " · " + date;
      }).join("\n\n"))
      .setFooter({ text: "Showing " + Math.min(count, history.length) + " of " + history.length + " scores" })
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== QUALITY_CHANNEL) return;
  const session = dashboardSessions.get(message.author.id);
  if (!session?.waitingFor) return;
  const attachments = [...message.attachments.values()].filter(a => a.contentType?.startsWith("image/"));
  if (!attachments.length) return;
  if (session.waitingFor === "rep") {
    session.repUrls = attachments.map(a => a.url);
    session.repUrl = attachments[0].url;
  } else {
    session.authUrl = attachments[0].url;
  }
  session.waitingFor = null;
  try {
    const channel = await client.channels.fetch(QUALITY_CHANNEL);
    const dashMsg = await channel.messages.fetch(session.messageId);
    await dashMsg.edit({ embeds: [buildDashboardEmbed(session)], components: [buildDashboardButtons(session)] });
    await message.react("✅");
  } catch (e) {
    console.error("Failed to update dashboard:", e);
  }
});

client.login(process.env.DISCORD_TOKEN);