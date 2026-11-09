import type { CategoriaId } from './categorias';

export type TipoUnidade = 'governo' | 'ong';

export interface Unidade {
  id: string;
  nome: string;
  categoria: CategoriaId;
  tipo: TipoUnidade;
  lat: number;
  lng: number;
  endereco: string;
  municipio: string;
  uf: string;
  telefone: string | null;
  horario: string | null;
  atende: string | null; // o que atende / público
  documentos: string | null; // documentos a levar
  fonte: string;
  verificado: boolean; // confirmado por telefone
  // Campos de parceiro da rede (categoria 'parceiro'):
  contato?: string | null; // ponto de contato nomeado
  oferece?: string | null; // o que a org oferece à rede
  precisa?: string | null; // o que a org precisa (mobilização de recursos)
}
