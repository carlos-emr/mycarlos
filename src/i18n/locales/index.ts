import type { Locale, Message } from "../types";
import { en, type MessageKey } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { pl } from "./pl";
import { ptBR } from "./pt-BR";

export type { MessageKey };

export const CATALOGUES: Record<Locale, Record<MessageKey, Message>> = {
  en,
  fr,
  es,
  pl,
  "pt-BR": ptBR,
};
