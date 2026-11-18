#!/usr/bin/env node
// Scraper da rede de apoio -> public/unidades.json
//
// Uso:
//   node scripts/scrape.mjs capitais              # 27 capitais (overnight)
//   node scripts/scrape.mjs <codigoIBGE6>         # 1 município
//   node scripts/scrape.mjs <IBGE6> --bairros "a,b" --saida out.json
//
// <codigoIBGE6> = código IBGE do MUNICÍPIO, 6 dígitos (sem dígito verificador).
//   Ex.: São Paulo capital 3550308 -> 355030.
//
// Fontes:
//   - CNES (saúde): UBS, CAPS  [apidadosabertos.saude.gov.br]           ✅
//   - OpenStreetMap/Overpass: CRAS, CREAS, Conselho Tutelar, OSC,       ✅
//     Escola, Curso (SENAI/SENAC/faculdade)
//
// Merge: começa do unidades.json existente e faz upsert por id. Assim um
// erro parcial do Overpass não apaga o que já temos (ex.: os 4040 do CNES).
//
// Regra do projeto: dados saem como `verificado:false`. Confirmar por telefone
// e marcar true. Ninguém confia em cadastro público sem ligar.

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = 'redes-de-apoio-scraper/1.0 (mapa civico estatico)';

// ---------- args ----------
const argv = process.argv.slice(2);
const municipio = argv[0];
if (!municipio || !(/^\d{6}$/.test(municipio) || municipio === 'capitais')) {
  console.error('ERRO: informe o código IBGE (6 dígitos sem verificador) ou "capitais".');
  console.error('Ex.: node scripts/scrape.mjs 355030');
  console.error('     node scripts/scrape.mjs capitais');
  process.exit(1);
}
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
}
const bairrosFiltro = (flag('bairros') || '')
  .split(',')
  .map((b) => b.trim().toUpperCase())
  .filter(Boolean);
const SAIDA = flag('saida') || resolve(__dirname, '../public/unidades.json');
let MUNICIPIO_NOME = flag('municipio') || '';
let UF = (flag('uf') || '').toUpperCase();

// caps p/ não estourar o JSON (fetch em runtime no browser)
const ESCOLA_CAP = Number(flag('escola-cap') || 120); // por cidade
const CURSO_CAP = Number(flag('curso-cap') || 40);

// ---------- util ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tentativas = 4) {
  for (let t = 0; t < tentativas; t++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (t === tentativas - 1) throw e;
      await sleep(1500 * (t + 1));
    }
  }
}

function titulo(s) {
  if (!s) return s;
  return String(s)
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
function formatTel(t) {
  if (!t) return null;
  const d = String(t).replace(/\D/g, '');
  if (d.length < 8) return null;
  return String(t).trim();
}

// ========================================================================
// CNES (saúde): UBS, CAPS
// ========================================================================
const CNES_BASE = 'https://apidadosabertos.saude.gov.br/cnes/estabelecimentos';
// codigo_tipo_unidade: 2=Centro de Saúde/UBS, 1=Posto de Saúde, 70=CAPS.
const CNES_TIPOS = { 2: 'ubs', 1: 'ubs', 70: 'caps' };

async function scrapeCNES(cod) {
  const out = [];
  for (const [tipo, categoria] of Object.entries(CNES_TIPOS)) {
    let offset = 0;
    const limit = 20; // a API capa ~20 por página
    for (;;) {
      const url = `${CNES_BASE}?codigo_municipio=${cod}&codigo_tipo_unidade=${tipo}&limit=${limit}&offset=${offset}`;
      let data;
      try {
        data = await getJson(url);
      } catch (e) {
        console.error(`  CNES tipo ${tipo}: erro ${e.message} (offset ${offset}), sigo`);
        break;
      }
      const lista = data?.estabelecimentos ?? [];
      if (lista.length === 0) break;
      for (const e of lista) {
        const lat = e.latitude_estabelecimento_decimo_grau;
        const lng = e.longitude_estabelecimento_decimo_grau;
        if (lat == null || lng == null) continue;
        const bairro = (e.bairro_estabelecimento || '').toUpperCase();
        if (bairrosFiltro.length && !bairrosFiltro.includes(bairro)) continue;
        const nome = e.nome_fantasia || e.nome_razao_social || 'Estabelecimento';
        const endereco = [e.endereco_estabelecimento, e.numero_estabelecimento, e.bairro_estabelecimento]
          .filter(Boolean)
          .join(', ');
        out.push({
          id: `cnes-${e.codigo_cnes}`,
          nome: titulo(nome),
          categoria,
          tipo: 'governo',
          lat,
          lng,
          endereco,
          municipio: MUNICIPIO_NOME,
          uf: UF,
          telefone: formatTel(e.numero_telefone_estabelecimento),
          horario: e.descricao_turno_atendimento ? titulo(e.descricao_turno_atendimento) : null,
          atende: categoria === 'ubs' ? 'Atendimento de saúde, vacinas, consultas' : 'Saúde mental, álcool e outras drogas',
          documentos: categoria === 'ubs' ? 'Cartão SUS e comprovante de residência' : 'Cartão SUS',
          fonte: 'CNES',
          verificado: false,
        });
      }
      offset += limit;
      await sleep(300);
    }
    console.error(`  CNES tipo ${tipo} (${categoria}): ${out.filter((o) => o.categoria === categoria).length}`);
  }
  return out;
}

// ========================================================================
// OpenStreetMap / Overpass: CRAS, CREAS, Conselho Tutelar, OSC, Escola, Curso
// ========================================================================
const OVERPASS_EPS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

async function overpass(q) {
  const body = 'data=' + encodeURIComponent(q);
  const H = { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'application/json' };
  for (let t = 0; t < 8; t++) {
    const ep = OVERPASS_EPS[t % OVERPASS_EPS.length];
    try {
      const r = await fetch(ep, { method: 'POST', body, headers: H });
      if ([429, 502, 503, 504].includes(r.status)) {
        await sleep(4000 * (t + 1)); // servidor ocupado: backoff
        continue;
      }
      if (!r.ok) {
        await sleep(2000);
        continue;
      }
      return await r.json();
    } catch {
      await sleep(2500 * (t + 1));
    }
  }
  console.error('  Overpass: esgotou tentativas, retornando vazio');
  return { elements: [] };
}

// bbox do município via Nominatim (cache em memória por processo)
const bboxCache = new Map();
async function bboxMunicipio(nome, uf) {
  const key = `${nome}|${uf}`;
  if (bboxCache.has(key)) return bboxCache.get(key);
  const url =
    'https://nominatim.openstreetmap.org/search?format=json&limit=1' +
    `&city=${encodeURIComponent(nome)}&state=${encodeURIComponent(uf)}&country=Brazil`;
  let bb = null;
  try {
    const j = await getJson(url);
    const b = j?.[0]?.boundingbox; // [south, north, west, east]
    if (b) bb = { s: +b[0], n: +b[1], w: +b[2], e: +b[3] };
  } catch (e) {
    console.error(`  Nominatim erro p/ ${nome}: ${e.message}`);
  }
  await sleep(1100); // política Nominatim: ~1 req/s
  bboxCache.set(key, bb);
  return bb;
}

function osmId(e) {
  return `osm-${e.type?.[0] || 'x'}${e.id}`;
}
function osmCoord(e) {
  if (e.lat != null && e.lon != null) return [e.lat, e.lon];
  if (e.center) return [e.center.lat, e.center.lon];
  return [null, null];
}
function osmEndereco(t) {
  const rua = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(', ');
  return [rua, t['addr:suburb'] || t['addr:neighbourhood'], t['addr:city']].filter(Boolean).join(' - ');
}
function temTagComercial(t) {
  if (t.shop || t.craft) return true;
  if (t.office && ['company', 'it', 'lawyer', 'estate_agent', 'insurance', 'telecommunication'].includes(t.office)) return true;
  if (t.amenity && ['restaurant', 'cafe', 'fast_food', 'bar', 'fuel', 'bank', 'pharmacy'].includes(t.amenity)) return true;
  return false;
}

// classifica um elemento OSM social/nominal -> categoria do projeto (ou null)
function classificar(t) {
  if (t.highway) return null;
  const name = t.name || '';
  const anchored = (re) => re.test(name);
  if (anchored(/^\s*creas\b/i) || /\(creas\)/i.test(name)) return temTagComercial(t) ? null : 'creas';
  if (anchored(/^\s*cras\b/i) || /\(cras\)/i.test(name)) return temTagComercial(t) ? null : 'cras';
  if (/conselho tutelar/i.test(name)) return temTagComercial(t) ? null : 'conselho_tutelar';
  if (t.amenity === 'social_facility' || t.amenity === 'social_centre' || t.office === 'charity' || t.office === 'ngo')
    return 'osc';
  return null;
}

const META = {
  cras: {
    tipo: 'governo',
    atende: 'Famílias em vulnerabilidade, CadÚnico, Bolsa Família, benefícios',
    documentos: 'RG, CPF e comprovante de residência',
  },
  creas: {
    tipo: 'governo',
    atende: 'Vítimas de violência, situação de rua, medidas protetivas',
    documentos: 'RG e CPF (se tiver)',
  },
  conselho_tutelar: {
    tipo: 'governo',
    atende: 'Crianças e adolescentes em situação de risco',
    documentos: 'Documento da criança/adolescente, se tiver',
  },
  osc: { tipo: 'ong', atende: 'Ações sociais (alimentos, roupas, abrigo) — confirmar por telefone', documentos: null },
  escola: {
    tipo: 'governo',
    atende: 'Matrícula e vagas na rede pública',
    documentos: 'RG, CPF, comprovante de residência e histórico escolar',
  },
  curso: { tipo: 'ong', atende: 'Cursos gratuitos e capacitação profissional', documentos: 'RG e CPF' },
};

function montar(e, categoria) {
  const t = e.tags || {};
  const [lat, lng] = osmCoord(e);
  if (lat == null || lng == null) return null;
  const m = META[categoria];
  // OSM já vem com capitalização correta (não title-case: estragaria acentos).
  const nome = t.name ? String(t.name).trim() : CATEGORIA_NOME[categoria];
  return {
    id: osmId(e),
    nome,
    categoria,
    tipo: m.tipo,
    lat,
    lng,
    endereco: osmEndereco(t),
    municipio: MUNICIPIO_NOME,
    uf: UF,
    telefone: formatTel(t.phone || t['contact:phone']),
    horario: t.opening_hours || null,
    atende: m.atende,
    documentos: m.documentos,
    fonte: 'OpenStreetMap',
    verificado: false,
  };
}
const CATEGORIA_NOME = {
  cras: 'CRAS',
  creas: 'CREAS',
  conselho_tutelar: 'Conselho Tutelar',
  osc: 'Organização social',
  escola: 'Escola',
  curso: 'Curso / capacitação',
};

function boxStr(bb) {
  return `(${bb.s},${bb.w},${bb.n},${bb.e})`;
}

// consulta social (cras/creas/conselho/osc) num bbox
async function osmSocial(bb) {
  const b = boxStr(bb);
  const q = `[out:json][timeout:180];
(
  node["amenity"="social_facility"]${b};
  way["amenity"="social_facility"]${b};
  node["amenity"="social_centre"]${b};
  way["amenity"="social_centre"]${b};
  node["office"="charity"]${b};
  way["office"="charity"]${b};
  node["office"="ngo"]${b};
  way["office"="ngo"]${b};
  node["name"~"CRAS|CREAS|Conselho Tutelar",i]${b};
  way["name"~"CRAS|CREAS|Conselho Tutelar",i]${b};
);
out center tags;`;
  const j = await overpass(q);
  const out = [];
  for (const e of j.elements || []) {
    const cat = classificar(e.tags || {});
    if (!cat) continue;
    const u = montar(e, cat);
    if (u) out.push(u);
  }
  return out;
}

// escolas (amenity=school), com cap
async function osmEscolas(bb) {
  const b = boxStr(bb);
  const q = `[out:json][timeout:180];
(
  node["amenity"="school"]${b};
  way["amenity"="school"]${b};
);
out center tags;`;
  const j = await overpass(q);
  const out = [];
  for (const e of j.elements || []) {
    const t = e.tags || {};
    if (t.isced_level === '3' && /tecn/i.test(t.name || '')) {
      /* técnica: ainda escola */
    }
    const u = montar(e, 'escola');
    if (u && u.nome) out.push(u);
    if (out.length >= ESCOLA_CAP) break;
  }
  return out;
}

// cursos: SENAI/SENAC + faculdade/escola técnica
async function osmCursos(bb) {
  const b = boxStr(bb);
  // Só rede gratuita/pública de qualificação (evita universidade privada).
  const q = `[out:json][timeout:180];
(
  node["name"~"SENAI|SENAC|Escola Técnica|ETEC|Instituto Federal|IFPR|IFSP|FATEC|CEDESP",i]${b};
  way["name"~"SENAI|SENAC|Escola Técnica|ETEC|Instituto Federal|IFPR|IFSP|FATEC|CEDESP",i]${b};
);
out center tags;`;
  const j = await overpass(q);
  const out = [];
  const vistos = new Set();
  for (const e of j.elements || []) {
    const t = e.tags || {};
    if (t.highway) continue;
    const u = montar(e, 'curso');
    if (!u || !u.nome || vistos.has(u.id)) continue;
    vistos.add(u.id);
    out.push(u);
    if (out.length >= CURSO_CAP) break;
  }
  return out;
}

async function scrapeOSM() {
  if (!MUNICIPIO_NOME || !UF) {
    console.error('  OSM: sem nome/UF do município, pulo');
    return [];
  }
  const bb = await bboxMunicipio(MUNICIPIO_NOME, UF);
  if (!bb) {
    console.error('  OSM: sem bbox (Nominatim), pulo');
    return [];
  }
  const out = [];
  try {
    const social = await osmSocial(bb);
    out.push(...social);
    const porCat = {};
    for (const u of social) porCat[u.categoria] = (porCat[u.categoria] || 0) + 1;
    console.error(`  OSM social: ${social.length}`, porCat);
  } catch (e) {
    console.error(`  OSM social erro: ${e.message}`);
  }
  await sleep(1500);
  try {
    const esc = await osmEscolas(bb);
    out.push(...esc);
    console.error(`  OSM escola: ${esc.length} (cap ${ESCOLA_CAP})`);
  } catch (e) {
    console.error(`  OSM escola erro: ${e.message}`);
  }
  await sleep(1500);
  try {
    const cur = await osmCursos(bb);
    out.push(...cur);
    console.error(`  OSM curso: ${cur.length} (cap ${CURSO_CAP})`);
  } catch (e) {
    console.error(`  OSM curso erro: ${e.message}`);
  }
  // dedup por nome+coord (OSM mapeia mesmo lugar como node E way -> ids diferentes)
  const vistos = new Set();
  return out.filter((u) => {
    const k = `${u.nome.toLowerCase()}|${u.lat.toFixed(4)}|${u.lng.toFixed(4)}`;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

// ---------- IBGE: nome + UF a partir do código de 6 dígitos ----------
async function preencherMunicipio(cod6) {
  if (MUNICIPIO_NOME && UF) return;
  try {
    const lista = await getJson('https://servicodados.ibge.gov.br/api/v1/localidades/municipios?orderBy=nome');
    const m = lista.find((x) => String(x.id).slice(0, 6) === cod6);
    if (m) {
      MUNICIPIO_NOME = MUNICIPIO_NOME || m.nome;
      UF = UF || m.microrregiao?.mesorregiao?.UF?.sigla || '';
      console.error(`  município: ${MUNICIPIO_NOME} - ${UF}`);
    } else {
      console.error('  AVISO: código IBGE não encontrado; município/UF vazios.');
    }
  } catch {
    console.error('  AVISO: não consegui consultar o IBGE; passe --municipio e --uf.');
  }
}

// ---------- capitais (26 estados + DF) ----------
const CAPITAIS = [
  ['120040', 'Rio Branco', 'AC'],
  ['270430', 'Maceió', 'AL'],
  ['160030', 'Macapá', 'AP'],
  ['130260', 'Manaus', 'AM'],
  ['292740', 'Salvador', 'BA'],
  ['230440', 'Fortaleza', 'CE'],
  ['530010', 'Brasília', 'DF'],
  ['320530', 'Vitória', 'ES'],
  ['520870', 'Goiânia', 'GO'],
  ['211130', 'São Luís', 'MA'],
  ['510340', 'Cuiabá', 'MT'],
  ['500270', 'Campo Grande', 'MS'],
  ['310620', 'Belo Horizonte', 'MG'],
  ['150140', 'Belém', 'PA'],
  ['250750', 'João Pessoa', 'PB'],
  ['410690', 'Curitiba', 'PR'],
  ['261160', 'Recife', 'PE'],
  ['221100', 'Teresina', 'PI'],
  ['330455', 'Rio de Janeiro', 'RJ'],
  ['240810', 'Natal', 'RN'],
  ['431490', 'Porto Alegre', 'RS'],
  ['110020', 'Porto Velho', 'RO'],
  ['140010', 'Boa Vista', 'RR'],
  ['420540', 'Florianópolis', 'SC'],
  ['355030', 'São Paulo', 'SP'],
  ['280030', 'Aracaju', 'SE'],
  ['172100', 'Palmas', 'TO'],
];

async function scrapeMunicipio(cod) {
  const partes = await Promise.all([scrapeCNES(cod), scrapeOSM()]);
  return partes.flat();
}

// ---------- merge com arquivo existente ----------
async function carregarExistentes() {
  try {
    const txt = await readFile(SAIDA, 'utf8');
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ---------- main ----------
// Mapa acumulado em memória, começando do arquivo existente (upsert por id).
// Grava a cada cidade -> se o processo morrer no meio, não perde progresso.
const mapa = new Map();
for (const u of await carregarExistentes()) mapa.set(u.id, u);
let coletadasTotal = 0;

async function persistir() {
  const combinadas = [...mapa.values()];
  await writeFile(SAIDA, JSON.stringify(combinadas, null, 2) + '\n', 'utf8');
  return combinadas;
}
function absorver(lista) {
  let add = 0;
  for (const u of lista) {
    if (!mapa.has(u.id)) add++;
    mapa.set(u.id, u);
    coletadasTotal++;
  }
  return add;
}

if (municipio === 'capitais') {
  console.error(`Scraping ${CAPITAIS.length} capitais...`);
  let i = 0;
  for (const [cod, nome, uf] of CAPITAIS) {
    i++;
    MUNICIPIO_NOME = nome;
    UF = uf;
    console.error(`\n[${i}/${CAPITAIS.length}] ${nome} - ${uf} (${cod})`);
    try {
      const add = absorver(await scrapeMunicipio(cod));
      await persistir(); // grava progresso parcial
      console.error(`  salvo: +${add} novas (total ${mapa.size})`);
    } catch (e) {
      console.error(`  ERRO em ${nome}: ${e.message}, sigo`);
    }
  }
} else {
  console.error(`Scraping município ${municipio}${bairrosFiltro.length ? ` (bairros: ${bairrosFiltro.join(', ')})` : ''}...`);
  await preencherMunicipio(municipio);
  absorver(await scrapeMunicipio(municipio));
}

const combinadas = await persistir();
const porCat = {};
for (const u of combinadas) porCat[u.categoria] = (porCat[u.categoria] || 0) + 1;
console.error(`\nOK: ${combinadas.length} unidades (${coletadasTotal} coletadas nesta rodada) -> ${SAIDA}`);
console.error('Por categoria:', porCat);
