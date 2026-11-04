// Kino plugin: Latanime (latanime.org) — anime en latino y castellano.
// Solo lee lo que cualquiera vería en el sitio sin cuenta: el catálogo, los capítulos y los
// servidores que el propio sitio lista en cada episodio.
//
// Refs:
//   s~<slug>        una serie (anime)
//   v~<slug>~<n>    un capítulo
//   p~<base64>      un servidor concreto (las "alternativas" de un Stream)

const BASE = "https://latanime.org";
const TIMEOUT = 12000;
const MAX_ITEMS = 60;
const MAX_EPISODES = 3000;

function log(...args) {
  try {
    kino.log(...args);
  } catch {}
}

function es() {
  return String(kino.lang || "es-CO").toLowerCase().indexOf("en") !== 0;
}

function msg(esText, enText) {
  return es() ? esText : enText;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function getText(url, referer) {
  const headers = {};
  if (referer) headers.Referer = referer;
  const r = await kino.fetch(url, { headers, timeoutMs: TIMEOUT });
  if (!r.ok) throw new Error(url + " respondió " + r.status);
  return r.text();
}

function abs(path) {
  return new URL(path, BASE).href;
}

// Base64 seguro para URLs con caracteres fuera de Latin-1.
function encodeRef(url) {
  try {
    return btoa(encodeURIComponent(url));
  } catch {
    return btoa(url);
  }
}

function decodeRef(value) {
  let raw;

  try {
    raw = atob(value);
  } catch {
    throw new Error("ref inválida");
  }

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// Normaliza URLs de imágenes: absolutas, relativas y protocol-relative.
function imageUrl(value, pageUrl) {
  if (!value || typeof value !== "string") return undefined;

  let valueClean = value.trim().replace(/&amp;/gi, "&").replace(/&#38;/g, "&");

  if (!valueClean || /^(data:|blob:|javascript:)/i.test(valueClean)) {
    return undefined;
  }

  if (valueClean.startsWith("//")) {
    valueClean = "https:" + valueClean;
  }

  try {
    const url = new URL(valueClean, pageUrl || BASE);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }

    return url.href;
  } catch {
    return undefined;
  }
}

// Lee atributos aunque estén en distinto orden o usen comillas simples.
function attr(tag, name) {
  const re = new RegExp("\\b" + name + "\\s*=\\s*(['\\\"])(.*?)\\1", "i");
  const m = re.exec(tag);
  return m ? (m[2] || "").trim() : "";
}

function srcsetUrl(value) {
  if (!value) return "";

  const candidates = value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);

  return candidates.length ? candidates[candidates.length - 1] : "";
}

// Extrae portadas normales, lazy-load, picture y fondos CSS.
function extractImage(block, pageUrl) {
  const tags = [];
  const tagRe = /<(?:img|source)\b[^>]*>/gi;
  let m;

  while ((m = tagRe.exec(block))) {
    tags.push(m[0]);
  }

  const attributes = [
    "data-src",
    "data-lazy-src",
    "data-original",
    "data-original-src",
    "data-image",
    "data-poster",
    "data-url",
    "data-srcset",
    "srcset",
    "src",
  ];

  for (const tag of tags) {
    for (const name of attributes) {
      let candidate = attr(tag, name);

      if (name.includes("srcset")) {
        candidate = srcsetUrl(candidate);
      }

      const url = imageUrl(candidate, pageUrl);
      if (url) return url;
    }
  }

  // Fondos CSS.
  const bgRe =
    /background(?:-image)?\s*:\s*url\(\s*(['"]?)(.*?)\1\s*\)/gi;

  while ((m = bgRe.exec(block))) {
    const url = imageUrl(m[2], pageUrl);
    if (url) return url;
  }

  // Metadatos de portada.
  const metaRe = /<meta\b[^>]*>/gi;

  while ((m = metaRe.exec(block))) {
    const tag = m[0];
    const property = (
      attr(tag, "property") || attr(tag, "name")
    ).toLowerCase();

    if (
      property === "og:image" ||
      property === "twitter:image"
    ) {
      const url = imageUrl(attr(tag, "content"), pageUrl);
      if (url) return url;
    }
  }

  return undefined;
}

// ---- Lectura de tarjetas ----------------------------------------------------

const GENRES = {
  accion: "accion",
  comedia: "comedia",
  drama: "drama",
  fantasia: "fantasia",
  romance: "romance",
  terror: "terror",
  misterio: "misterio",
  "ciencia-ficcion": "ciencia-ficcion",
  deportes: "deportes",
  musica: "musica",
};

function clean(text, max) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max || 200);
}

// Corta el HTML en las tarjetas de una lista.
function parseCards(html, prefix) {
  const re = new RegExp(
    '<a\\b[^>]*href\\s*=\\s*(["\\\'])(?:https?:\\/\\/latanime\\.org)?\\/' +
      prefix +
      '\\/([^"\\\'\\s?#]+)',
    "gi"
  );

  const marks = [];
  let m;

  while ((m = re.exec(html))) {
    marks.push({
      slug: m[2],
      at: m.index,
      end: re.lastIndex,
    });
  }

  const out = [];
  const seen = new Set();

  for (let i = 0; i < marks.length && out.length < MAX_ITEMS; i++) {
    const slug = marks[i].slug;

    if (seen.has(slug)) continue;
    seen.add(slug);

    const from = marks[i].at;
    const next =
      i + 1 < marks.length
        ? marks[i + 1].at
        : Math.min(html.length, from + 2500);

    const chunk = html.slice(from, next);

    const previousEnd =
      i > 0
        ? marks[i - 1].end
        : Math.max(0, from - 1500);

    const before = html.slice(
      Math.max(previousEnd, from - 1500),
      from
    );

    // Busca la portada dentro de la tarjeta y antes del enlace.
    const poster =
      extractImage(chunk, BASE + "/") ||
      extractImage(before, BASE + "/");

    const titleM =
      /<strong\b[^>]*>([\s\S]*?)<\/strong>/i.exec(chunk) ||
      /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(chunk) ||
      /title\s*=\s*(["'])(.*?)\1/i.exec(chunk);

    const title = titleM
      ? clean(titleM[2] || titleM[1] || titleM[0])
      : slug.replace(/-/g, " ");

    const metaM =
      /(Pelicula|Latino|Castellano|Subtitulado|Anime)/i.exec(chunk);

    const yearM = /\b(19\d{2}|20\d{2})\b/.exec(chunk);

    out.push({
      slug,
      title: clean(title),
      poster,
      year: yearM ? yearM[1] : undefined,
      movie:
        !!metaM &&
        metaM[1].toLowerCase() === "pelicula",
    });
  }

  return out;
}

function seriesItem(c) {
  return {
    id: "s~" + c.slug,
    ref: "s~" + c.slug,
    title: c.title,
    kind: "series",
    year: c.year,
    poster: c.poster,
    genres: ["anime"],
  };
}

function movieItem(c) {
  return {
    id: "v~" + c.slug,
    ref: "v~" + c.slug + "~1",
    title: c.title,
    kind: "movie",
    year: c.year,
    poster: c.poster,
    genres: ["anime"],
  };
}

function splitEpisode(slug) {
  const m = /^(.*)-episodio-(\d+)$/.exec(slug);
  return m ? { slug: m[1], num: Number(m[2]) } : null;
}

// ---- search ----------------------------------------------------------------

export async function search(query) {
  await null;

  const terms = [];
  const seenTerm = new Set();

  for (const raw of [query && query.q, query && query.originalTitle]) {
    if (typeof raw !== "string" || !raw.trim()) continue;

    const text = kino.rank.shortQuery(raw).trim();
    const key = text.toLowerCase();

    if (!text || seenTerm.has(key)) continue;

    seenTerm.add(key);
    terms.push(text);

    if (terms.length === 2) break;
  }

  if (!terms.length) return [];

  const answers = await Promise.all(
    terms.map(async (term) => {
      try {
        return await getText(
          abs("/buscar?q=" + encodeURIComponent(term)),
          BASE + "/"
        );
      } catch (e) {
        log("búsqueda falló", term, e.message);
        return null;
      }
    })
  );

  if (answers.every((a) => a === null)) {
    throw kino.error("unavailable", "el sitio no respondió");
  }

  const found = [];
  const seen = new Set();

  for (const html of answers) {
    if (!html) continue;

    for (const c of parseCards(html, "anime")) {
      if (seen.has(c.slug)) continue;

      seen.add(c.slug);
      found.push(c);
    }
  }

  const relevant = kino.rank.filterRelevant(
    found,
    terms,
    (c) => c.title
  );

  const kept = relevant.length ? relevant : found;

  const sorted = kino.rank.sortBySimilarity(
    kept,
    terms,
    (c) => c.title
  );

  return sorted
    .slice(0, MAX_ITEMS)
    .map((c) => (c.movie ? movieItem(c) : seriesItem(c)));
}

// ---- home ------------------------------------------------------------------

export async function home() {
  await null;

  const [front, latino, castellano] = await Promise.all([
    getText(BASE + "/", BASE + "/").catch((e) => {
      log("Inicio falló", e.message);
      return null;
    }),

    getText(abs("/buscar?q=latino"), BASE + "/").catch(() => null),

    getText(abs("/buscar?q=castellano"), BASE + "/").catch(() => null),
  ]);

  const rows = [];

  const push = (id, title, items) => {
    if (items.length) {
      rows.push({
        id,
        title,
        genre: "anime",
        items: items.slice(0, MAX_ITEMS),
      });
    }
  };

  if (front) {
    const chapters = [];

    for (const c of parseCards(front, "ver")) {
      const ep = splitEpisode(c.slug);
      if (!ep) continue;

      chapters.push({
        id: "v~" + c.slug,
        ref: "v~" + ep.slug + "~" + ep.num,
        title: c.title,
        kind: "movie",
        poster: c.poster,
        genres: ["anime"],
      });
    }

    push(
      "recientes",
      msg("Últimos capítulos", "Latest episodes"),
      chapters
    );

    push(
      "series",
      msg("Series recientes", "Recent series"),
      parseCards(front, "anime").map(seriesItem)
    );
  }

  if (latino) {
    push(
      "latino",
      msg("En latino", "Latin Spanish"),
      parseCards(latino, "anime").map(seriesItem)
    );
  }

  if (castellano) {
    push(
      "castellano",
      msg("En castellano", "Castilian Spanish"),
      parseCards(castellano, "anime").map(seriesItem)
    );
  }

  if (!rows.length) {
    throw kino.error("unavailable", "el sitio no devolvió nada");
  }

  return rows;
}

// ---- episodes --------------------------------------------------------------

export async function episodes(ref) {
  await null;

  const parts = String(ref || "").split("~");
  const slug = parts[1] || "";

  if (parts[0] !== "s" || !slug) {
    throw kino.error("not_found", "esa serie ya no existe");
  }

  let html;

  try {
    html = await getText(abs("/anime/" + slug), BASE + "/");
  } catch (e) {
    throw kino.error(
      "not_found",
      "no se pudo abrir la serie: " + e.message
    );
  }

  const titleM = /<h2>([^<]+)<\/h2>/.exec(html);

  // Ahora también reconoce portadas lazy-load y URLs relativas.
  const seriesPoster = extractImage(
    html,
    abs("/anime/" + slug)
  );

  const overM =
    /<p class="my-2 opacity-75">([\s\S]*?)<\/p>/.exec(html);

  const genres = [];
  const genreRe = /\/genero\/([a-z0-9-]+)"/g;

  let g;

  while ((g = genreRe.exec(html)) && genres.length < 5) {
    const id = GENRES[g[1]];

    if (id && genres.indexOf(id) === -1) {
      genres.push(id);
    }
  }

  const list = [];
  const seen = new Set();

  const re =
    /<a\s+href="(?:https?:\/\/latanime\.org)?\/ver\/([^"\s]+)"[^>]*>([\s\S]*?)<\/a>/g;

  let m;

  while ((m = re.exec(html)) && list.length < MAX_EPISODES) {
    const ep = splitEpisode(m[1]);

    if (!ep || seen.has(m[1])) continue;

    seen.add(m[1]);

    const label = clean(m[2], 200);
    const tail = /-\s*(cap[ií]tulo\s+\d+.*)$/i.exec(label);

    list.push({
      season: 1,
      number: ep.num,
      ref: "v~" + ep.slug + "~" + ep.num,
      title:
        (tail ? tail[1] : label) ||
        msg("Capítulo " + ep.num, "Episode " + ep.num),
    });
  }

  if (!list.length) {
    throw kino.error("not_found", "esa serie no tiene capítulos");
  }

  list.sort((a, b) => a.number - b.number);

  return {
    series: {
      title: clean(titleM ? titleM[1] : slug),
      poster: seriesPoster,
      overview: overM ? clean(overM[1], 2000) : undefined,
      genres: genres.length ? genres : ["anime"],
    },
    episodes: list,
  };
}

// ---- resolve: servidores del capítulo -------------------------------------

const ORDER = ["mp4upload", "mixdrop", "hexload", "voe"];

function priority(host) {
  for (let i = 0; i < ORDER.length; i++) {
    if (host.indexOf(ORDER[i]) !== -1) return i;
  }

  return ORDER.length;
}

function parsePlayers(html) {
  const out = [];

  const re =
    /<a\b([^>]*data-player="([^"]+)"[^>]*)>([^<]*)<\/a>/g;

  let m;

  while ((m = re.exec(html))) {
    if (!/play-video/.test(m[1])) continue;

    let url;

    try {
      url = atob(m[2]);
    } catch {
      continue;
    }

    if (!/^https?:\/\//i.test(url)) continue;

    out.push({
      url,
      label: clean(m[3]) || hostOf(url),
    });
  }

  return out;
}

async function episodeHtml(slug, num) {
  const url = abs("/ver/" + slug + "-episodio-" + num);

  try {
    return await getText(url, BASE + "/");
  } catch (e) {
    if (num === 1) {
      try {
        return await getText(abs("/ver/" + slug), BASE + "/");
      } catch {}
    }

    throw e;
  }
}

export async function resolve(ref) {
  await null;

  const parts = String(ref || "").split("~");

  // Resolver una alternativa seleccionada.
  if (parts[0] === "p") {
    let url;

    try {
      url = decodeRef(parts.slice(1).join("~"));
    } catch {
      throw kino.error(
        "not_found",
        "no se pudo iniciar la reproducción"
      );
    }

    if (!/^https?:\/\//i.test(url)) {
      throw kino.error(
        "not_found",
        "no se pudo iniciar la reproducción"
      );
    }

    return await playEmbed(url);
  }

  if (parts[0] !== "v" || !parts[1]) {
    throw kino.error(
      "not_found",
      "esa dirección no es un capítulo"
    );
  }

  const slug = parts[1];
  const num = Number(parts[2]) || 1;

  let html;

  try {
    html = await episodeHtml(slug, num);
  } catch {
    throw kino.error(
      "not_found",
      "no se pudo abrir el capítulo"
    );
  }

  const players = parsePlayers(html);

  if (!players.length) {
    throw kino.error("not_found", "el capítulo no tiene servidores", {
      userMessage: msg(
        "Este capítulo no tiene servidores disponibles.",
        "This episode has no available servers."
      ),
    });
  }

  const ordered = players
    .slice()
    .sort(
      (a, b) =>
        priority(hostOf(a.url)) - priority(hostOf(b.url))
    );

  let stream = null;
  let selectedPlayer = null;

  // Prueba automáticamente los servidores.
  // No muestra sus nombres ni los errores individuales.
  for (let i = 0; i < ordered.length; i++) {
    try {
      stream = await playEmbed(ordered[i].url);
      selectedPlayer = ordered[i];
      break;
    } catch {
      // Continúa con el siguiente servidor.
    }
  }

  if (!stream || !selectedPlayer) {
    throw kino.error("unavailable", "no se pudo iniciar la reproducción", {
      userMessage: msg(
        "No se pudo iniciar la reproducción. Prueba otro capítulo o vuelve más tarde.",
        "Playback could not be started. Try another episode or come back later."
      ),
    });
  }

  // Construye las alternativas excluyendo el servidor principal.
  const alternatives = [];
  let n = 1;

  for (const player of ordered) {
    if (player === selectedPlayer) continue;

    alternatives.push({
      label: "Reproducir " + n++,
      ref: "p~" + encodeRef(player.url),
    });
  }

  // Devuelve el video principal y sus alternativas.
  return {
    ...stream,
    label: "Reproducir",
    alternatives,
  };
}

async function playEmbed(url) {
  const host = hostOf(url);

  if (host.endsWith("mp4upload.com")) {
    return await fromMp4upload(url);
  }

  if (host.indexOf("mixdrop") !== -1) {
    return await fromMixdrop(url);
  }

  if (host.endsWith("hexload.com")) {
    return await fromHexload(url);
  }

  if (host.endsWith("voe.sx")) {
    return await fromVoe(url);
  }

  throw new Error("sin extractor para " + host);
}

// ---- mp4upload -------------------------------------------------------------

async function fromMp4upload(url) {
  const idM = /(?:embed-|\/e\/)([a-z0-9]+)/i.exec(url);

  if (!idM) {
    throw new Error("id de mp4upload inválido");
  }

  const page =
    "https://www.mp4upload.com/embed-" + idM[1] + ".html";

  const html = await getText(
    page,
    "https://www.mp4upload.com/"
  );

  const m =
    /(?:src\s*:\s*|src=)"(https?:\/\/[^"]+?\.mp4[^"]*)"/i.exec(html);

  if (!m) {
    throw new Error("mp4upload sin archivo");
  }

  return {
    url: m[1],
    mime: "video/mp4",
    headers: { Referer: page },
  };
}

// ---- mixdrop ----------------------------------------------------------------

function base62(n, a) {
  const digit = n % a;
  const head = n < a ? "" : base62(Math.floor(n / a), a);

  return (
    head +
    (digit > 35
      ? String.fromCharCode(digit + 29)
      : digit.toString(36))
  );
}

function unpack(p, a, c, k) {
  let out = p;

  for (let n = c - 1; n >= 0; n--) {
    if (!k[n]) continue;

    out = out.replace(
      new RegExp("\\b" + base62(n, a) + "\\b", "g"),
      k[n]
    );
  }

  return out;
}

async function fromMixdrop(url) {
  const idM = /\/e\/([a-z0-9]+)/i.exec(url);

  if (!idM) {
    throw new Error("id de mixdrop inválido");
  }

  const page = "https://mixdrop.top/e/" + idM[1];
  const html = await getText(page, "https://mixdrop.top/");

  const m =
    /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/.exec(html);

  if (!m) {
    throw new Error("mixdrop sin jugador");
  }

  const code = unpack(
    m[1],
    Number(m[2]),
    Number(m[3]),
    m[4].split("|")
  );

  const fileM =
    /MDCore\.(?:furl|wurl)\s*=\s*"([^"]+)"/.exec(code);

  if (!fileM) {
    throw new Error("mixdrop sin archivo");
  }

  let file = fileM[1];

  if (file.startsWith("//")) {
    file = "https:" + file;
  }

  if (!/\.mp4(\?|$)/i.test(file)) {
    const alt = /MDCore\.wurl\s*=\s*"([^"]+)"/.exec(code);

    if (alt && /\.mp4(\?|$)/i.test(alt[1])) {
      file = alt[1].startsWith("//")
        ? "https:" + alt[1]
        : alt[1];
    } else {
      throw new Error("mixdrop sin mp4");
    }
  }

  return {
    url: file,
    mime: "video/mp4",
    headers: { Referer: page },
  };
}

// ---- hexload ----------------------------------------------------------------

async function fromHexload(url) {
  const idM = /(?:embed-|\/e\/)([a-z0-9]+)/i.exec(url);

  if (!idM) {
    throw new Error("id de hexload inválido");
  }

  const page = "https://hexload.com/embed-" + idM[1];

  const r = await kino.fetch(
    "https://hexload.com/download",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        Referer: page,
        Origin: "https://hexload.com",
      },
      body: {
        form: {
          op: "download3",
          id: idM[1],
          ajax: "1",
          method_free: "1",
        },
      },
      timeoutMs: TIMEOUT,
    }
  );

  if (!r.ok) {
    throw new Error("hexload respondió " + r.status);
  }

  let data;

  try {
    data = await r.json();
  } catch {
    throw new Error("hexload sin JSON");
  }

  if (
    !data ||
    data.msg !== "OK" ||
    !data.result ||
    !data.result.url
  ) {
    throw new Error("hexload sin archivo");
  }

  let file = String(data.result.url);

  if (!/^https?:\/\//i.test(file)) {
    try {
      file = atob(file);
    } catch {}
  }

  if (!/^https?:\/\//i.test(file)) {
    throw new Error("hexload con URL rara");
  }

  return {
    url: file,
    mime: "video/mp4",
    headers: { Referer: page },
  };
}

// ---- voe --------------------------------------------------------------------

function rot13(text) {
  return text.replace(/[a-zA-Z]/g, (ch) => {
    const c = ch.charCodeAt(0);
    const base = c <= 90 ? 65 : 97;

    return String.fromCharCode(
      ((c - base + 13) % 26) + base
    );
  });
}

async function fromVoe(url) {
  const idM = /\/e\/([a-z0-9]+)/i.exec(url);

  if (!idM) {
    throw new Error("id de voe inválido");
  }

  const page = "https://voe.sx/e/" + idM[1];
  const html = await getText(page, "https://voe.sx/");

  const blobM =
    /<script type="application\/json">\s*(\[[\s\S]*?\])\s*<\/script>/i.exec(html);

  if (!blobM) {
    throw new Error("voe sin datos");
  }

  const list = JSON.parse(blobM[1]);
  const encoded = Array.isArray(list) ? list[0] : null;

  if (typeof encoded !== "string") {
    throw new Error("voe con datos raros");
  }

  const clean1 = rot13(encoded).replace(
    /@\$|\^\^|~@|%\?|!!|#&|\*~/g,
    ""
  );

  const step1 = atob(clean1);

  let shifted = "";

  for (let i = 0; i < step1.length; i++) {
    shifted += String.fromCharCode(
      step1.charCodeAt(i) - 3
    );
  }

  const reversed = shifted.split("").reverse().join("");

  const json = JSON.parse(
    atob(reversed.replace(/^=+/, ""))
  );

  const file = json.source || json.direct_access_url;

  if (!file || !/^https?:\/\//i.test(file)) {
    throw new Error("voe sin archivo");
  }

  return {
    url: file,
    mime: /\.m3u8(\?|$)/i.test(file)
      ? "application/x-mpegURL"
      : "video/mp4",
    headers: { Referer: page },
  };
}