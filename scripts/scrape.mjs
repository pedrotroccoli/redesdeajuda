#!/usr/bin/env node
// Scraper da rede de apoio -> src/data/unidades.json
//
// Uso:
//   node scripts/scrape.mjs <codigoIBGE6> [--bairros "a,b,c"] [--saida arquivo.json]
//
// <codigoIBGE6> = código IBGE do MUNICÍPIO com 6 dígitos (sem dígito verificador).
//   Ex.: São Paulo capital 3550308 -> 355030.  Descubra em https://www.ibge.gov.br/
//
// Fontes implementadas:
//   - CNES (saúde): UBS, CAPS  [apidadosabertos.saude.gov.br]  ✅
// Fontes pendentes (stubs abaixo): CRAS/CREAS (CadSUAS), OSC (Mapa das OSC/IPEA),
//   Escola (INEP). Conselho Tutelar não tem base nacional -> entrada manual.
//
// Regra do projeto: dados saem como `verificado:false`. Confirmar por telefone
// e marcar true. Ninguém confia em cadastro público sem ligar.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
const saida = flag('saida') || resolve(__dirname, '../public/unidades.json');
let MUNICIPIO_NOME = flag('municipio') || '';
let UF = (flag('uf') || '').toUpperCase();

// ---------- util ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tentativas = 3) {
  for (let t = 0; t < tentativas; t++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (t === tentativas - 1) throw e;
      await sleep(1500 * (t + 1));
    }
  }
}

function slug(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// ---------- CNES (saúde) ----------
const CNES_BASE = 'https://apidadosabertos.saude.gov.br/cnes/estabelecimentos';
// codigo_tipo_unidade -> nossa categoria. (confirmar no município real; tipos
// CNES: 2=Centro de Saúde/UBS, 1=Posto de Saúde, 70=CAPS, 73=Pronto Atend/UPA.)
const CNES_TIPOS = {
  2: 'ubs',
  1: 'ubs',
  70: 'caps',
};

async function scrapeCNES(cod) {
  const out = [];
  for (const [tipo, categoria] of Object.entries(CNES_TIPOS)) {
    let offset = 0;
    const limit = 20; // a API capa ~20 por página
    for (;;) {
      const url = `${CNES_BASE}?codigo_municipio=${cod}&codigo_tipo_unidade=${tipo}&limit=${limit}&offset=${offset}`;
      const data = await getJson(url);
      const lista = data?.estabelecimentos ?? [];
      if (lista.length === 0) break;
      for (const e of lista) {
        const lat = e.latitude_estabelecimento_decimo_grau;
        const lng = e.longitude_estabelecimento_decimo_grau;
        if (lat == null || lng == null) continue; // sem coord -> geocodar depois
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
          atende: null,
          documentos: categoria === 'ubs' ? 'Cartão SUS e comprovante de residência' : 'Cartão SUS',
          fonte: 'CNES',
          verificado: false,
        });
      }
      offset += limit;
      await sleep(300); // educado com a API
    }
    console.error(`  CNES tipo ${tipo} (${categoria}): ${out.filter((o) => o.categoria === categoria).length}`);
  }
  return out;
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

// ---------- stubs (próximas fontes) ----------
async function scrapeCadSUAS(_cod) {
  // TODO: CRAS/CREAS. Fonte provável: MDS SAGI / CadSUAS por município.
  console.error('  CadSUAS (CRAS/CREAS): pendente');
  return [];
}
async function scrapeOSC(_cod) {
  // TODO: Mapa das OSC (IPEA) -> API interna por código IBGE.
  console.error('  OSC (IPEA): pendente');
  return [];
}

// ---------- IBGE: nome + UF a partir do código de 6 dígitos ----------
async function preencherMunicipio(cod6) {
  if (MUNICIPIO_NOME && UF) return;
  try {
    const lista = await getJson(
      'https://servicodados.ibge.gov.br/api/v1/localidades/municipios?orderBy=nome'
    );
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
  const partes = await Promise.all([scrapeCNES(cod), scrapeCadSUAS(cod), scrapeOSC(cod)]);
  return partes.flat();
}

// ---------- main ----------
let unidades = [];

if (municipio === 'capitais') {
  console.error(`Scraping ${CAPITAIS.length} capitais...`);
  for (const [cod, nome, uf] of CAPITAIS) {
    MUNICIPIO_NOME = nome;
    UF = uf;
    console.error(`\n${nome} - ${uf} (${cod})`);
    unidades.push(...(await scrapeMunicipio(cod)));
  }
} else {
  console.error(`Scraping município ${municipio}${bairrosFiltro.length ? ` (bairros: ${bairrosFiltro.join(', ')})` : ''}...`);
  await preencherMunicipio(municipio);
  unidades = await scrapeMunicipio(municipio);
}

// dedupe por id
const vistos = new Set();
unidades = unidades.filter((u) => (vistos.has(u.id) ? false : vistos.add(u.id)));

await writeFile(saida, JSON.stringify(unidades, null, 2) + '\n', 'utf8');
console.error(`\nOK: ${unidades.length} unidades -> ${saida}`);
