// Type definitions for the application's data model

export interface CirculationInShift {
  codi: string;
  sortida: string;
  arribada: string;
  cicle: string;
  observacions?: string;
}

export interface Shift {
  id: string;
  servei: string;
  iniciTorn: string;
  finalTorn: string;
  duracio: string;
  dependencia: string;
  circulations: CirculationInShift[];
}

export interface Circulation {
  id: string;
  linia: string;
  inici: string;
  sortida: string;
  final: string;
  arribada: string;
  estacions: { nom: string; hora: string; }[];
}

export interface Driver {
  nom: string;
  nomina: string;
  observacions?: string;
}

export interface PhonebookEntry {
    nomina: string;
    nom: string;
    cognom1: string;
    cognom2: string;
    phones: string[];
}


export interface Db {
  shifts: Map<string, Shift>;
  circulations: Map<string, Circulation>;
  drivers: Map<string, Driver[]>;
  phonebook: Map<string, PhonebookEntry>;
  allCycleIds: Set<string>;
  allStations: Set<string>;
}

export interface Overlap {
    station: string;
    start: string;
    end: string;
}

export interface PresenceInterval {
    station: string;
    startMinutes: number;
    endMinutes: number;
    startTime: string;
    endTime: string;
    startReason: string;
    endReason: string;
}

export interface ComparisonResultData {
    shift1: Shift;
    shift2: Shift;
    overlaps: Overlap[];
    intervals1: PresenceInterval[];
    intervals2: PresenceInterval[];
    lastCirculation1: CirculationInShift | null;
    lastCirculation2: CirculationInShift | null;
}