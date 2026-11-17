const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ActivityType,
  PermissionFlagsBits,
  MessageFlags,
  Events,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// =====================================================================
//  AYARLAR (.env)
// =====================================================================
const env = process.env;

for (const key of ["TOKEN", "GUILD_ID", "ROLE_ID"]) {
  if (!env[key]) {
    console.error(`❌ .env dosyasında ${key} eksik.`);
    process.exit(1);
  }
}

function numEnv(key, def) {
  const n = parseFloat(env[key]);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

const guildId = env.GUILD_ID;
const roleId = env.ROLE_ID;
const adminRoleId = env.ADMIN_ROLE_ID || null; // isteğe bağlı (Yönetici izni zaten yeterli)
const logChannelId = env.LOG_CHANNEL_ID || null; // isteğe bağlı
const warnChannelId = env.WARN_CHANNEL_ID || null; // isteğe bağlı: tolerans süresi uyarısı (düz mesaj)

const tagSources = {
  username: env.CHECK_USERNAME === "true",
  globalName: env.CHECK_GLOBAL_NAME === "true",
  customStatus: env.CHECK_CUSTOM_STATUS === "true",
  guildTag: env.CHECK_GUILD_TAG === "true", // Discord'un resmi "Sunucu Etiketi" özelliği
};

// Hangi sunucunun etiketi aranacak? Boşsa bu sunucunun kendi etiketi
const guildTagServerId = env.GUILD_TAG_SERVER_ID || guildId;

const banSystemEnabled = env.ENABLE_BAN_SYSTEM === "true";
const dmEnabled = env.ENABLE_DM !== "false"; // varsayılan: açık
const graceMinutes = numEnv("GRACE_MINUTES", 10); // etiket silinince beklenecek süre (0 = hemen)
const banDays = numEnv("BAN_DURATION_DAYS", 7); // kara liste süresi (0 = süresiz)

const DAY = 24 * 60 * 60 * 1000;
const COLORS = {
  green: 0x2ecc71,
  red: 0xe74c3c,
  yellow: 0xf1c40f,
  blue: 0x3498db,
  orange: 0xe67e22,
  gray: 0x95a5a6,
  dark: 0x2c3e50,
};

// =====================================================================
//  DOSYA İŞLEMLERİ
// =====================================================================
const tagsFile = path.join(__dirname, "tags.json");
const banlistFile = path.join(__dirname, "banlist.json");
const grantedFile = path.join(__dirname, "granted.json"); // botun rol verdiği kişiler

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return { data: fallback, existed: false };
  try {
    return { data: JSON.parse(fs.readFileSync(file, "utf-8")), existed: true };
  } catch (err) {
    console.error(`❌ ${path.basename(file)} okunamadı, yedeği alınıyor:`, err.message);
    try {
      fs.copyFileSync(file, file + ".bak");
    } catch {}
    return { data: fallback, existed: true };
  }
}

// Yazarken dosya bozulmasın diye önce geçici dosyaya yazıp yeniden adlandırır
function writeJson(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// --- Etiketler
let tags = readJson(tagsFile, []).data;
if (!Array.isArray(tags)) tags = [];
const saveTags = () => writeJson(tagsFile, tags);

// --- Kara liste: { "kullaniciId": { addedAt, expiresAt|null, reason, by } }
let banList = {};
{
  const loaded = readJson(banlistFile, {});
  if (Array.isArray(loaded.data)) {
    // Eski format (sadece ID listesi) -> yeni formata aktar
    const now = Date.now();
    for (const id of loaded.data) {
      banList[id] = {
        addedAt: now,
        expiresAt: banDays > 0 ? now + banDays * DAY : null,
        reason: "Eski listeden aktarıldı",
        by: "aktarım",
      };
    }
    writeJson(banlistFile, banList);
    console.log(`ℹ️ Eski banlist.json yeni formata aktarıldı (${loaded.data.length} kişi).`);
  } else if (loaded.data && typeof loaded.data === "object") {
    banList = loaded.data;
  }
}
const saveBanList = () => writeJson(banlistFile, banList);

// --- Botun rol verdiği kişiler (elle verilen roller bu listede olmaz, bot onlara dokunmaz)
const grantedLoad = readJson(grantedFile, []);
const granted = new Set(Array.isArray(grantedLoad.data) ? grantedLoad.data : []);
let needSeed = !grantedLoad.existed;
const saveGranted = () => writeJson(grantedFile, [...granted]);

// =====================================================================
//  KARA LİSTE FONKSİYONLARI
// =====================================================================
function getBan(userId) {
  const ban = banList[userId];
  if (!ban) return null;
  if (ban.expiresAt && ban.expiresAt <= Date.now()) return null; // süresi dolmuş
  return ban;
}

function addBan(userId, { days = banDays, reason = "Etiket silindi", by = "bot" } = {}) {
  const now = Date.now();
  banList[userId] = {
    addedAt: now,
    expiresAt: days > 0 ? now + days * DAY : null,
    reason,
    by,
  };
  saveBanList();
  return banList[userId];
}

function removeBan(userId) {
  if (!banList[userId]) return false;
  delete banList[userId];
  saveBanList();
  return true;
}

// Süresi dolanları dosyadan siler, ID listesini döndürür
function pruneBans() {
  const now = Date.now();
  const expired = [];
  for (const [id, ban] of Object.entries(banList)) {
    if (ban.expiresAt && ban.expiresAt <= now) {
      expired.push(id);
      delete banList[id];
    }
  }
  if (expired.length) saveBanList();
  return expired;
}

// =====================================================================
//  YARDIMCILAR (log, zaman, hata)
// =====================================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = (ms, style = "R") => `<t:${Math.floor(ms / 1000)}:${style}>`;
const who = id => `<@${id}>`;

function logEmbed(title, color, description, fields = []) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription(description)
    .setTimestamp();
  if (fields.length) embed.addFields(fields);
  return embed;
}

async function sendLog(embed) {
  if (!logChannelId) return;
  try {
    const channel = await client.channels.fetch(logChannelId);
    if (channel?.isTextBased()) await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("Log kanalına yazılamadı:", err.message);
  }
}

function logError(context, err) {
  console.error(`❌ ${context}:`, err);
  const hint =
    err?.code === 50013
      ? "\n💡 Botun rolü, verilecek rolün **üstünde** olmalı ve **Rolleri Yönet** izni olmalı."
      : "";
  const message = String(err?.message || err).slice(0, 500);
  sendLog(logEmbed("⚠️ Hata", COLORS.orange, `**${context}**\n\`${message}\`${hint}`));
}

// =====================================================================
//  BOT
// =====================================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.GuildMember],
});

// =====================================================================
//  ETİKET KONTROLÜ
// =====================================================================
/**
 * Sonuç:
 *  tagged  -> etiket bulundu
 *  unknown -> etiket yok ama doğrulanamıyor (çevrimdışı özel durum, kontrol edilecek kaynak yok vb.)
 *             Bu durumda rol ASLA geri alınmaz.
 */
function evaluateTag(member) {
  const result = { tagged: false, unknown: false, matches: [], sources: {}, note: null };
  const list = tags.map(t => t.toLowerCase()).filter(Boolean);
  const textEnabled = list.length > 0; // metin etiketi yoksa metin kaynakları atlanır

  const anySource =
    tagSources.guildTag ||
    (textEnabled && (tagSources.username || tagSources.globalName || tagSources.customStatus));
  if (!anySource) {
    result.unknown = true;
    result.note = "Kontrol edilecek kaynak yok (etiket listesi boş veya kaynaklar kapalı).";
    return result;
  }

  const find = value => list.find(t => value.includes(t)) || null;

  // --- Discord Sunucu Etiketi (resmi özellik)
  if (tagSources.guildTag) {
    const pg = member.user.primaryGuild;
    const active = !!pg && pg.identityEnabled === true && pg.identityGuildId === guildTagServerId;
    result.sources.guildTag = {
      tag: pg?.tag || null,
      guildId: pg?.identityGuildId || null,
      enabled: pg?.identityEnabled ?? null,
      match: active,
    };
    if (active) result.matches.push({ source: "Sunucu etiketi", tag: pg.tag || "—" });
  }

  if (textEnabled && tagSources.username) {
    const value = member.user.username || "";
    const match = find(value.toLowerCase());
    result.sources.username = { value, match };
    if (match) result.matches.push({ source: "Kullanıcı adı", tag: match });
  }

  if (textEnabled && tagSources.globalName) {
    const value = member.user.globalName || "";
    const match = find(value.toLowerCase());
    result.sources.globalName = { value, match };
    if (match) result.matches.push({ source: "Global ad", tag: match });
  }

  if (textEnabled && tagSources.customStatus) {
    const presence = member.presence;
    // Çevrimdışı/görünmez kullanıcıların durumu okunamaz -> "bilinmiyor"
    if (!presence || presence.status === "offline") {
      result.sources.customStatus = { known: false };
    } else {
      const activity = presence.activities?.find(a => a.type === ActivityType.Custom);
      const value = activity?.state || "";
      const match = find(value.toLowerCase());
      result.sources.customStatus = { known: true, value, match };
      if (match) result.matches.push({ source: "Özel durum", tag: match });
    }
  }

  result.tagged = result.matches.length > 0;
  result.unknown = !result.tagged && result.sources.customStatus?.known === false;
  if (result.unknown) result.note = "Özel durum okunamadı (kullanıcı çevrimdışı/görünmez).";
  return result;
}

// =====================================================================
//  ROL GÜNCELLEME
// =====================================================================
const busy = new Set(); // aynı kişi için eşzamanlı işlemi engeller
const pending = new Map(); // bekleyen rol kaldırmaları: userId -> { timer, endsAt }

async function updateMemberRole(member) {
  if (!member || member.user.bot || member.guild.id !== guildId) return "skip";
  if (busy.has(member.id)) return "busy";
  busy.add(member.id);
  try {
    return await applyRole(member);
  } finally {
    busy.delete(member.id);
  }
}

async function applyRole(member) {
  const hasRole = member.roles.cache.has(roleId);
  const ban = getBan(member.id);
  const ev = evaluateTag(member);

  // Rol başka yolla alınmışsa takip listesinden çıkar
  if (!hasRole && granted.has(member.id)) {
    granted.delete(member.id);
    saveGranted();
    cancelPending(member.id);
  }

  if (ev.tagged) {
    cancelPending(member.id, "Etiket tekrar bulundu.");

    if (!hasRole && !ban) {
      try {
        await member.roles.add(roleId, "Etiket bulundu");
      } catch (err) {
        logError(`Rol verilemedi (${member.user.tag})`, err);
        return "error";
      }
      granted.add(member.id);
      saveGranted();
      const matchText = ev.matches.map(m => `${m.source}: \`${m.tag}\``).join("\n");
      sendLog(logEmbed("✅ Rol verildi", COLORS.green, `${who(member.id)} (\`${member.user.tag}\`)\n${matchText}`));
      return "granted";
    }

    if (hasRole && ban && granted.has(member.id)) {
      try {
        await member.roles.remove(roleId, "Kara listede");
      } catch (err) {
        logError(`Rol alınamadı (${member.user.tag})`, err);
        return "error";
      }
      granted.delete(member.id);
      saveGranted();
      sendLog(logEmbed("⛔ Kara liste: rol alındı", COLORS.red, `${who(member.id)} kara listede olduğu için rolü alındı.`));
      return "banned-removed";
    }
    return "ok";
  }

  // Etiket yok ama doğrulanamıyor -> dokunma
  if (ev.unknown) return "unknown";

  // Etiket kesin olarak yok. Sadece botun verdiği rol geri alınır.
  if (hasRole && granted.has(member.id)) {
    scheduleRemoval(member.id);
    return "pending";
  }
  return "untagged";
}

function cancelPending(userId, reason) {
  const entry = pending.get(userId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(userId);
  entry.warnMsg?.delete().catch(() => {}); // etiket geri geldiyse uyarı mesajını sil
  if (reason) {
    sendLog(logEmbed("↩️ Rol kaldırma iptal edildi", COLORS.blue, `${who(userId)}\n${reason}`));
  }
  return true;
}

// Tolerans süresi uyarısı: embed'siz düz mesaj, ayrı kanala
async function sendWarning(userId, endsAt, entry) {
  if (!warnChannelId) return;
  try {
    const channel = await client.channels.fetch(warnChannelId);
    if (!channel?.isTextBased()) return;
    const msg = await channel.send({
      content: `⚠️ <@${userId}>, etiketin bulunamadı. Etiketi ${ts(endsAt, "R")} geri takmazsan rolün alınacak.`,
      allowedMentions: { users: [userId] },
    });
    if (pending.get(userId) === entry) entry.warnMsg = msg;
    else msg.delete().catch(() => {}); // gönderilirken iptal edildiyse sil
  } catch (err) {
    console.error("Uyarı kanalına yazılamadı:", err.message);
  }
}

function scheduleRemoval(userId) {
  if (pending.has(userId)) return;
  const ms = graceMinutes * 60 * 1000;

  if (ms <= 0) {
    finalizeRemoval(userId).catch(err => logError("Rol kaldırma hatası", err));
    return;
  }

  const endsAt = Date.now() + ms;
  const timer = setTimeout(() => {
    pending.delete(userId);
    finalizeRemoval(userId).catch(err => logError("Rol kaldırma hatası", err));
  }, ms);
  const entry = { timer, endsAt, warnMsg: null };
  pending.set(userId, entry);
  sendWarning(userId, endsAt, entry);

  sendLog(
    logEmbed(
      "⏳ Etiket bulunamadı",
      COLORS.yellow,
      `${who(userId)}\nTekrar kontrol: ${ts(endsAt, "R")} (${graceMinutes} dk tolerans)`
    )
  );
}

// Tolerans süresi bitince taze veriyle tekrar kontrol eder
async function finalizeRemoval(userId) {
  const guild = await client.guilds.fetch(guildId);

  let member;
  try {
    member = await guild.members.fetch({ user: userId, force: true });
  } catch (err) {
    if (err.code === 10007) {
      // Kullanıcı sunucudan ayrılmış
      granted.delete(userId);
      saveGranted();
      return;
    }
    throw err;
  }

  if (!member.roles.cache.has(roleId)) {
    granted.delete(userId);
    saveGranted();
    return;
  }

  const ev = evaluateTag(member);
  if (ev.tagged) {
    sendLog(logEmbed("↩️ Rol kaldırma iptal edildi", COLORS.blue, `${who(userId)}\nEtiket tolerans süresinde geri eklendi.`));
    return;
  }
  if (ev.unknown) {
    sendLog(logEmbed("↩️ Rol kaldırma iptal edildi", COLORS.blue, `${who(userId)}\nEtiket doğrulanamadı (${ev.note}) — rol bırakıldı.`));
    return;
  }

  try {
    await member.roles.remove(roleId, "Etiket silindi");
  } catch (err) {
    logError(`Rol alınamadı (${member.user.tag})`, err);
    return;
  }
  granted.delete(userId);
  saveGranted();

  let ban = null;
  if (banSystemEnabled && !getBan(userId)) {
    ban = addBan(userId, { reason: "Etiket silindi", by: "bot" });
  }

  const fields = [];
  if (ban) {
    fields.push({
      name: "Kara liste",
      value: ban.expiresAt ? `Bitiş: ${ts(ban.expiresAt, "f")} (${ts(ban.expiresAt, "R")})` : "Süresiz",
    });
  }
  sendLog(
    logEmbed("❌ Rol alındı (etiket silindi)", COLORS.red, `${who(userId)} (\`${member.user.tag}\`)`, fields)
  );

  await dmRoleRemoved(member, ban);
}

async function dmRoleRemoved(member, ban) {
  if (!dmEnabled) return;
  const lines = [`**${member.guild.name}** sunucusunda etiketini sildiğin için rolün alındı.`];
  if (ban) {
    lines.push(
      ban.expiresAt
        ? `Etiketi tekrar eklesen bile ${ts(ban.expiresAt, "f")} tarihine kadar rol verilmeyecek.`
        : "Etiketi tekrar eklesen bile rol verilmeyecek. Gerekirse yetkililerle iletişime geç."
    );
  } else {
    lines.push("Etiketi tekrar eklersen rolün otomatik olarak verilecek.");
  }
  try {
    await member.send({
      embeds: [logEmbed("Rolün alındı", COLORS.red, lines.join("\n\n"))],
    });
  } catch {
    // DM'ler kapalıysa yapılacak bir şey yok
    console.log(`DM gönderilemedi (DM kapalı olabilir): ${member.user.tag}`);
  }
}

// =====================================================================
//  TARAMA
// =====================================================================
let scanning = false;

async function scanAll() {
  if (scanning) return null;
  scanning = true;
  try {
    const guild = await client.guilds.fetch(guildId);
    const members = await guild.members.fetch({ withPresences: true, time: 120000 });

    // İlk çalıştırma: rol sahibi ve etiketli olanları "bot verdi" say
    if (needSeed && tags.length > 0) {
      for (const m of members.values()) {
        if (m.user.bot) continue;
        if (m.roles.cache.has(roleId) && evaluateTag(m).tagged) granted.add(m.id);
      }
      saveGranted();
      needSeed = false;
    }

    const counts = {};
    for (const m of members.values()) {
      const result = await updateMemberRole(m);
      counts[result] = (counts[result] || 0) + 1;
      if (result === "granted" || result === "banned-removed") await sleep(400); // rate limit
    }
    return counts;
  } finally {
    scanning = false;
  }
}

async function handleExpiredBans() {
  const expired = pruneBans();
  if (!expired.length) return;
  const guild = await client.guilds.fetch(guildId);
  for (const id of expired) {
    sendLog(logEmbed("🔓 Kara liste süresi doldu", COLORS.gray, who(id)));
    try {
      const member = await guild.members.fetch(id);
      await updateMemberRole(member);
    } catch (err) {
      if (err.code !== 10007) logError(`Süresi dolan kullanıcı işlenemedi (${id})`, err);
    }
  }
}

// =====================================================================
//  SLASH KOMUTLARI
// =====================================================================
const cmd = (name, description) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false);

const commands = [
  cmd("etiket-ekle", "Bir etiketi listeye ekler.").addStringOption(o =>
    o.setName("tag").setDescription("Eklenecek etiket").setRequired(true)
  ),
  cmd("etiket-kaldir", "Listeden bir etiketi kaldırır.").addStringOption(o =>
    o.setName("tag").setDescription("Kaldırılacak etiket").setRequired(true)
  ),
  cmd("etiketler", "Tüm etiketleri listeler."),
  cmd("say", "Etiketli/etiketsiz üye sayılarını gösterir."),
  cmd("ban-list-ekle", "Bir kullanıcıyı kara listeye ekler.")
    .addUserOption(o => o.setName("kullanici").setDescription("Kara listeye eklenecek kullanıcı").setRequired(true))
    .addIntegerOption(o =>
      o
        .setName("gun")
        .setDescription("Kaç gün kara listede kalsın? (0 = süresiz, boşsa .env'deki değer)")
        .setMinValue(0)
        .setMaxValue(365)
    )
    .addStringOption(o => o.setName("sebep").setDescription("Sebep (isteğe bağlı)")),
  cmd("ban-list-kaldir", "Bir kullanıcıyı kara listeden çıkarır.").addUserOption(o =>
    o.setName("kullanici").setDescription("Kara listeden çıkarılacak kullanıcı").setRequired(true)
  ),
  cmd("ban-listesi", "Kara listedeki kullanıcıları gösterir."),
  cmd("kontrol", "Bir kullanıcının neden rol aldığını/almadığını gösterir.").addUserOption(o =>
    o.setName("kullanici").setDescription("Kontrol edilecek kullanıcı").setRequired(true)
  ),
  cmd("yeniden-tara", "Tüm üyeleri elle yeniden kontrol eder."),
].map(c => c.toJSON());

async function deployCommands() {
  if (env.CLIENT_ID && env.CLIENT_ID !== client.user.id) {
    console.warn(
      `⚠️ .env'deki CLIENT_ID (${env.CLIENT_ID}) bu token'ın botuyla (${client.user.id}) uyuşmuyor. Botun kendi ID'si kullanılıyor.`
    );
  }
  const rest = new REST({ version: "10" }).setToken(env.TOKEN);
  try {
    console.log("Slash komutları Discord'a yükleniyor...");
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
    console.log("Slash komutları başarıyla yüklendi.");
  } catch (err) {
    logError("Slash komutları yüklenirken hata", err);
  }
}

const EPH = { flags: MessageFlags.Ephemeral };
const reply = (interaction, content) => interaction.reply({ content, ...EPH });

function adminLog(interaction, text) {
  sendLog(logEmbed("🛠️ Yönetici işlemi", COLORS.dark, `${interaction.user} → ${text}`));
}

function describeSources(ev) {
  const s = ev.sources;
  const row = (label, x) => {
    if (!x) return `${label}: kapalı`;
    if (x.known === false) return `${label}: ⚠️ okunamadı (çevrimdışı/görünmez)`;
    const value = (x.value || "—").slice(0, 60);
    return `${label}: \`${value}\` → ${x.match ? `✅ \`${x.match}\`` : "❌ eşleşme yok"}`;
  };
  const guildTagRow = () => {
    const x = s.guildTag;
    if (!x) return "Sunucu etiketi: kapalı";
    if (!x.tag && !x.guildId) return "Sunucu etiketi: ❌ takmıyor";
    if (x.match) return `Sunucu etiketi: ✅ \`${x.tag || "—"}\``;
    if (x.enabled === false) return `Sunucu etiketi: ❌ etiket gösterimi kapalı${x.tag ? ` (\`${x.tag}\`)` : ""}`;
    return `Sunucu etiketi: ❌ başka sunucunun etiketi${x.tag ? ` (\`${x.tag}\`)` : ""}`;
  };
  return [
    guildTagRow(),
    row("Kullanıcı adı", s.username),
    row("Global ad", s.globalName),
    row("Özel durum", s.customStatus),
  ].join("\n");
}

function explain({ ev, hasRole, ban, isGranted, isPending }) {
  if (ev.tagged && hasRole) return "Etiket bulunduğu için rolü var.";
  if (ev.tagged && !hasRole && ban) return "Etiketi var ama kara listede olduğu için rol verilmiyor.";
  if (ev.tagged && !hasRole) return "Etiketi var ama rolü yok. Bot bir sonraki kontrolde verecek (olmazsa log kanalındaki hataya bak).";
  if (ev.unknown && hasRole) return `Etiket doğrulanamıyor (${ev.note}) — bu yüzden rolüne dokunulmuyor.`;
  if (ev.unknown) return `Etiket doğrulanamıyor (${ev.note}).`;
  if (hasRole && !isGranted) return "Etiketi yok ama rol bot tarafından verilmemiş (elle verilmiş), bu yüzden bot dokunmuyor.";
  if (hasRole && isPending) return "Etiketi yok, rolü tolerans süresi sonunda tekrar kontrol edilip alınacak.";
  if (hasRole) return "Etiketi yok, rol kısa süre içinde alınacak.";
  return "Etiketi yok, rolü de yok.";
}

async function handleCommand(interaction) {
  const guild = interaction.guild;

  switch (interaction.commandName) {
    case "etiket-ekle": {
      const tag = interaction.options.getString("tag", true).trim();
      if (!tag) return reply(interaction, "❗ Geçerli bir etiket yaz.");
      if (tags.some(t => t.toLowerCase() === tag.toLowerCase())) {
        return reply(interaction, "❗ Etiket zaten listede.");
      }
      tags.push(tag);
      saveTags();
      adminLog(interaction, `etiket eklendi: \`${tag}\``);
      return reply(interaction, `✅ Etiket eklendi: \`${tag}\``);
    }

    case "etiket-kaldir": {
      const tag = interaction.options.getString("tag", true).trim().toLowerCase();
      const index = tags.findIndex(t => t.toLowerCase() === tag);
      if (index === -1) return reply(interaction, "❗ Bu etiket listede yok.");
      const [removed] = tags.splice(index, 1);
      saveTags();
      adminLog(interaction, `etiket kaldırıldı: \`${removed}\``);
      return reply(interaction, `❌ Etiket kaldırıldı: \`${removed}\``);
    }

    case "etiketler": {
      const list = tags.length ? tags.map(t => `• \`${t}\``).join("\n") : "Etiket listesi boş.";
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Etiket Listesi").setColor("Blue").setDescription(list)],
        ...EPH,
      });
    }

    case "say": {
      await interaction.deferReply(EPH);
      const members = guild.members.cache.filter(m => !m.user.bot);
      const tagged = [];
      let untagged = 0;
      let unknown = 0;
      for (const m of members.values()) {
        const ev = evaluateTag(m);
        if (ev.tagged) tagged.push(m);
        else if (ev.unknown) unknown++;
        else untagged++;
      }
      const activeBans = Object.keys(banList).filter(id => getBan(id)).length;

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Etiket Durumu")
            .setColor("Green")
            .addFields(
              { name: "Etiketli", value: String(tagged.length), inline: true },
              { name: "Etiketsiz", value: String(untagged), inline: true },
              { name: "Doğrulanamayan", value: String(unknown), inline: true },
              { name: "Kara liste", value: `${activeBans} kullanıcı`, inline: true },
              { name: "Bekleyen kaldırma", value: String(pending.size), inline: true },
              { name: "Bot tarafından verilen rol", value: String(granted.size), inline: true }
            ),
        ],
      });
    }

    case "ban-list-ekle": {
      const user = interaction.options.getUser("kullanici", true);
      if (user.bot) return reply(interaction, "❗ Botlar kara listeye eklenemez.");
      const days = interaction.options.getInteger("gun") ?? banDays;
      const reason = interaction.options.getString("sebep") || "Yönetici tarafından eklendi";

      const ban = addBan(user.id, { days, reason, by: interaction.user.id });
      cancelPending(user.id);

      let note = "";
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (member?.roles.cache.has(roleId)) {
        try {
          await member.roles.remove(roleId, "Kara listeye eklendi");
          granted.delete(user.id);
          saveGranted();
          note = " Rolü de alındı.";
        } catch (err) {
          logError(`Rol alınamadı (${user.tag})`, err);
          note = " ⚠️ Rol alınamadı, log kanalına bak.";
        }
      }

      const until = ban.expiresAt ? `${ts(ban.expiresAt, "f")} tarihine kadar` : "süresiz";
      adminLog(interaction, `${who(user.id)} kara listeye eklendi (${until}). Sebep: ${reason}`);
      return reply(interaction, `⛔ ${user.tag} kara listeye eklendi (${until}).${note}`);
    }

    case "ban-list-kaldir": {
      const user = interaction.options.getUser("kullanici", true);
      const removed = removeBan(user.id);
      if (!removed) return reply(interaction, "❗ Bu kullanıcı kara listede değil.");

      let note = "";
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (member) {
        const result = await updateMemberRole(member);
        if (result === "granted") note = " Etiketi olduğu için rolü verildi.";
      }
      adminLog(interaction, `${who(user.id)} kara listeden çıkarıldı.`);
      return reply(interaction, `✅ ${user.tag} kara listeden kaldırıldı.${note}`);
    }

    case "ban-listesi": {
      const entries = Object.entries(banList)
        .filter(([id]) => getBan(id))
        .sort((a, b) => b[1].addedAt - a[1].addedAt);
      if (!entries.length) return reply(interaction, "Kara liste boş.");

      const shown = entries.slice(0, 20).map(([id, b]) => {
        const reason = (b.reason || "—").slice(0, 40);
        const until = b.expiresAt ? `bitiş ${ts(b.expiresAt, "R")}` : "süresiz";
        return `• ${who(id)} — ${reason} • ${until}`;
      });
      if (entries.length > 20) shown.push(`…ve ${entries.length - 20} kişi daha`);

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`Kara Liste (${entries.length})`)
            .setColor("Red")
            .setDescription(shown.join("\n")),
        ],
        ...EPH,
      });
    }

    case "kontrol": {
      const user = interaction.options.getUser("kullanici", true);
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) return reply(interaction, "❗ Bu kullanıcı sunucuda değil.");

      const ev = evaluateTag(member);
      const hasRole = member.roles.cache.has(roleId);
      const ban = getBan(user.id);
      const isGranted = granted.has(user.id);
      const entry = pending.get(user.id);

      const tagStatus = ev.tagged ? "✅ Etiketli" : ev.unknown ? "⚠️ Doğrulanamıyor" : "❌ Etiketsiz";
      const banText = ban
        ? `⛔ Kara listede (${ban.expiresAt ? `bitiş ${ts(ban.expiresAt, "R")}` : "süresiz"})\nSebep: ${(ban.reason || "—").slice(0, 100)}`
        : "Yok";

      const embed = new EmbedBuilder()
        .setTitle(`Kontrol: ${user.tag}`)
        .setColor(ev.tagged ? "Green" : ev.unknown ? "Yellow" : "Red")
        .setDescription(explain({ ev, hasRole, ban, isGranted, isPending: !!entry }))
        .addFields(
          { name: "Etiket", value: tagStatus, inline: true },
          { name: "Rol", value: hasRole ? (isGranted ? "✅ Var (bot verdi)" : "✅ Var (elle/başka yolla)") : "❌ Yok", inline: true },
          { name: "Kaynaklar", value: describeSources(ev) },
          { name: "Kara liste", value: banText }
        );
      if (entry) {
        embed.addFields({ name: "Bekleyen kaldırma", value: `Tekrar kontrol: ${ts(entry.endsAt, "R")}` });
      }
      return interaction.reply({ embeds: [embed], ...EPH });
    }

    case "yeniden-tara": {
      await interaction.deferReply(EPH);
      const counts = await scanAll();
      if (!counts) return interaction.editReply("⏳ Zaten bir tarama sürüyor, birazdan tekrar dene.");
      const total = Object.entries(counts)
        .filter(([k]) => k !== "skip")
        .reduce((sum, [, n]) => sum + n, 0);
      adminLog(interaction, "elle yeniden tarama başlattı.");
      return interaction.editReply(
        [
          `✅ Tarama tamamlandı (${total} üye)`,
          `• Rol verildi: ${counts.granted || 0}`,
          `• Kaldırma planlandı: ${counts.pending || 0}`,
          `• Kara listeden dolayı rol alındı: ${counts["banned-removed"] || 0}`,
          `• Doğrulanamayan (çevrimdışı özel durum): ${counts.unknown || 0}`,
          `• Hata: ${counts.error || 0}`,
        ].join("\n")
      );
    }
  }
}

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.guildId !== guildId) {
    return reply(interaction, "❌ Bu bot sadece yapılandırılan sunucuda çalışır.");
  }

  const isAdmin =
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    (adminRoleId && interaction.member.roles.cache.has(adminRoleId));
  if (!isAdmin) return reply(interaction, "❌ Bu komutu kullanma yetkin yok.");

  try {
    await handleCommand(interaction);
  } catch (err) {
    logError(`/${interaction.commandName} komutunda hata`, err);
    const msg = "❌ Komut çalışırken bir hata oluştu. Log kanalına/konsola bak.";
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: msg, ...EPH }).catch(() => {});
    else await reply(interaction, msg).catch(() => {});
  }
});

// =====================================================================
//  OLAYLAR
// =====================================================================
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot aktif: ${client.user.tag}`);

  await deployCommands();

  try {
    const counts = await scanAll();
    if (counts) {
      console.log("Açılış taraması tamamlandı:", counts);
      sendLog(
        logEmbed(
          "🔄 Açılış taraması tamamlandı",
          COLORS.gray,
          `Rol verildi: **${counts.granted || 0}** • Kaldırma planlandı: **${counts.pending || 0}** • Doğrulanamayan: **${counts.unknown || 0}** • Hata: **${counts.error || 0}**`
        )
      );
    }
    await handleExpiredBans();
  } catch (err) {
    logError("Açılış taraması başarısız", err);
  }

  // Süresi dolan kara listeleri saatlik temizle
  setInterval(() => {
    handleExpiredBans().catch(err => logError("Kara liste temizliği başarısız", err));
  }, 60 * 60 * 1000);

  // Durum mesajları döngüsü
  const statuses = ["💎 | .gg/YAEjW6drVY", "👨‍💻 | By Zywexx"];
  setInterval(() => {
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    client.user.setPresence({
      activities: [{ name: status, type: ActivityType.Watching }],
      status: "idle",
    });
  }, 10000);
});

client.on(Events.PresenceUpdate, (_, newPresence) => {
  if (newPresence.guild?.id !== guildId || !newPresence.member) return;
  updateMemberRole(newPresence.member).catch(err => logError("Presence güncellemesi", err));
});

client.on(Events.GuildMemberUpdate, (_, newMember) => {
  if (newMember.guild.id !== guildId) return;
  updateMemberRole(newMember).catch(err => logError("Üye güncellemesi", err));
});

// Kullanıcı profilindeki değişiklikler (sunucu etiketi dahil)
client.on(Events.UserUpdate, (_, newUser) => {
  const member = client.guilds.cache.get(guildId)?.members.cache.get(newUser.id);
  if (!member) return;
  updateMemberRole(member).catch(err => logError("Kullanıcı güncellemesi", err));
});

client.on(Events.GuildMemberAdd, member => {
  if (member.guild.id !== guildId) return;
  updateMemberRole(member).catch(err => logError("Yeni üye kontrolü", err));
});

client.on(Events.GuildMemberRemove, member => {
  if (member.guild.id !== guildId) return;
  cancelPending(member.id);
  if (granted.delete(member.id)) saveGranted();
});

client.on(Events.Error, err => console.error("Client hatası:", err));
process.on("unhandledRejection", err => console.error("Yakalanmamış hata:", err));

client.login(env.TOKEN);