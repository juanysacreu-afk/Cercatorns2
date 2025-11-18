// Access pdf.js and xlsx from the global window scope
declare const pdfjsLib: any;
declare const XLSX: any;

// FIX: Import the Db type for strong typing.
import type { Db, Driver } from '../types.ts';

// Set worker source for pdf.js once the library is available
if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.5.136/pdf.worker.min.mjs';
}

export const readFileAsText = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve(event.target?.result as string);
    reader.onerror = (error) => reject(error);
    reader.readAsText(file, 'ISO-8859-1'); // Latin encoding
  });
};

export const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(event.target?.result as ArrayBuffer);
        reader.onerror = (error) => reject(error);
        reader.readAsArrayBuffer(file);
    });
};

const normalizeShiftId = (id: string): string => {
    if (id && id.startsWith('Q')) {
        const numPart = id.substring(1);
        // Check if the part after 'Q' is purely numeric before padding
        if (/^\d+$/.test(numPart)) {
            return 'Q' + numPart.padStart(4, '0');
        }
    }
    return id; // Return original if not a standard numeric shift
};


const parseCSV = (content: string, delimiter = ';') => {
  const lines = content.split(/[\r\n]+/).filter(line => line.trim() !== '');
  if (lines.length < 2) return { header: [], rows: [] };

  const header = lines.shift()!.split(delimiter).map(h => h.trim());
  const rows = lines.map(line => {
    const values = line.split(delimiter);
    return header.reduce((obj: {[key: string]: string}, col, i) => {
      obj[col] = values[i] ? values[i].trim() : '';
      return obj;
    }, {});
  });
  return { header, rows };
};

// FIX: Change db parameter from 'any' to the specific 'Db' type for type safety.
export const processDataCSV = (content: string, db: Db) => {
  const { rows } = parseCSV(content);
  for (const row of rows) {
    if (!row.Torn) continue;

    const tornId = normalizeShiftId(row.Torn);

    if (!db.shifts.has(tornId)) {
      db.shifts.set(tornId, {
        id: tornId,
        servei: row.Servei,
        iniciTorn: row['Inici Torn'],
        finalTorn: row['Final Torn'],
        duracio: row['Duració Torn'],
        dependencia: row.Dependencia,
        circulations: [],
      });
    }

    if (row['Codi Tren']) {
      // FIX: Add non-null assertion since the shift is guaranteed to exist at this point.
      db.shifts.get(tornId)!.circulations.push({
        codi: row['Codi Tren'],
        sortida: row['Hora Sortida'],
        arribada: row['Hora Arribada'],
        cicle: row.Cicle,
        observacions: row.Observacions || undefined,
      });
    }

    if (row.Cicle) {
      db.allCycleIds.add(row.Cicle);
    }
  }
};

// FIX: Change db parameter from 'any' to the specific 'Db' type for type safety.
export const processServeiCSV = (content: string, db: Db) => {
  const { rows } = parseCSV(content);
  for (const row of rows) {
    const circId = row.Circulacio;
    if (!circId || db.circulations.has(circId)) continue;

    const estacions = [];
    for (let i = 1; row[`Estacio ${i}`]; i++) {
      const nom = row[`Estacio ${i}`];
      const hora = row[`Hora estacio ${i}`];
      if (nom) {
        estacions.push({ nom, hora });
        db.allStations.add(nom);
      }
    }

    if (row.Inici) db.allStations.add(row.Inici);
    if (row.Final) db.allStations.add(row.Final);

    db.circulations.set(circId, {
      id: circId,
      linia: row.Linia,
      inici: row.Inici,
      sortida: row['Hora Sortida'],
      final: row.Final,
      arribada: row['Hora arribada'],
      estacions: estacions,
    });
  }
};

// Helper function to find the correct service-specific shift ID.
// It maps IDs like 'QS02' from driver files to 'Q0S02' or 'Q1S02' found in the main shift data.
const findCorrectShiftId = (baseId: string, db: Db): string => {
    if (!baseId.startsWith('Q') || baseId.length < 3) {
        return baseId;
    }

    const prefix = baseId.substring(1, 2);
    const isSpecialPrefix = ['P', 'S', 'N'].includes(prefix);
    const isSpecialQF = baseId === 'QF00';

    if (isSpecialPrefix || isSpecialQF) {
        const restOfId = baseId.substring(1);
        
        // Check for service '0' version (e.g., Q0S02)
        const service0Id = `Q0${restOfId}`;
        if (db.shifts.has(service0Id)) {
            return service0Id;
        }

        // Check for service '100' version (e.g., Q1S02)
        const service1Id = `Q1${restOfId}`;
        if (db.shifts.has(service1Id)) {
            return service1Id;
        }
    }
    
    // If no match is found, return the original ID
    return baseId;
};

// FIX: Change db parameter from 'any' to the specific 'Db' type for type safety.
export const processDriverCSV = (content: string, db: Db) => {
  const { rows } = parseCSV(content);
  for (const row of rows) {
    if (!row.Torn) continue;
    
    const baseTornId = normalizeShiftId(row.Torn);
    const tornId = findCorrectShiftId(baseTornId, db);

    const driver: Driver = {
      nom: row['Nom i Cognoms'],
      nomina: row['numero de nomina'],
    };

    if (!db.drivers.has(tornId)) {
        db.drivers.set(tornId, []);
    }
    db.drivers.get(tornId)!.push(driver);
  }
};

// FIX: Change db parameter from 'any' to the specific 'Db' type for type safety.
export const processDriverPDF = async (file: File, db: Db) => {
    const arrayBuffer = await readFileAsArrayBuffer(file);
    const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
    const numPages = pdf.numPages;

    const lineRegex = /(Q\w+).*?(\d{5})\s+(.*)/;
    const observationKeywords = new Set(['NN', 'SN', 'NS', 'SS', 'N', 'S', 'PT', 'BS', 'TD', 'Inici', 'Fins']);

    for (let i = 1; i <= numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        
        if (!textContent.items || textContent.items.length === 0) continue;

        const linesMap = new Map<number, { str: string; x: number }[]>();
        const yTolerance = 2; 

        textContent.items.forEach((item: any) => {
            if (!item.str || item.str.trim() === '') return;
            const y = item.transform[5];
            let foundKey: number | null = null;
            for (const key of linesMap.keys()) {
                if (Math.abs(key - y) < yTolerance) {
                    foundKey = key;
                    break;
                }
            }
            const key = foundKey !== null ? foundKey : y;
            if (!linesMap.has(key)) linesMap.set(key, []);
            linesMap.get(key)!.push({ str: item.str, x: item.transform[4] });
        });
        
        const sortedLines = Array.from(linesMap.entries()).sort((a, b) => b[0] - a[0]);

        const textLines = sortedLines.map(([, itemsOnLine]) =>
            itemsOnLine.sort((a, b) => a.x - b.x).map(item => item.str).join(' ')
        );
        
        for (const line of textLines) {
            const match = line.match(lineRegex);
            if (match) {
                const [, rawTornId, nomina, restOfLine] = match;
                const words = restOfLine.trim().split(/\s+/);
                const nameParts = [];
                let nameEndIndex = -1;
                
                for (let j = 0; j < words.length; j++) {
                    const word = words[j];
                    if (observationKeywords.has(word) || /^\d{1,2}:\d{2}/.test(word) || /^\d{1,2}[-.]\d{1,2}/.test(word)) {
                        nameEndIndex = j;
                        break;
                    }
                    nameParts.push(word);
                }

                const nom = nameParts.join(' ').trim();
                const observacions = nameEndIndex !== -1 ? words.slice(nameEndIndex).join(' ') : '';
                
                if (rawTornId && nomina && nom) {
                    const baseTornId = normalizeShiftId(rawTornId);
                    const tornId = findCorrectShiftId(baseTornId, db);
                    const driver: Driver = { nom, nomina, observacions: observacions || undefined };
                    if (!db.drivers.has(tornId)) {
                        db.drivers.set(tornId, []);
                    }
                    db.drivers.get(tornId)!.push(driver);
                }
            }
        }
    }
};

// FIX: Change db parameter from 'any' to the specific 'Db' type for type safety.
export const processPhonebookXLSX = async (file: File, db: Db) => {
    const arrayBuffer = await readFileAsArrayBuffer(file);
    const workbook = XLSX.read(arrayBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    // Convert sheet to JSON, assuming the first row is the header.
    const jsonData: any[] = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

    // Assuming a specific column order: 
    // Nomina, Cognom1, Cognom2, Nom, Tel1, Tel2, Tel3
    // Skip header row (index 0)
    for (let i = 1; i < jsonData.length; i++) {
        const row = jsonData[i];
        if (!row || !row[0]) continue; // Skip empty rows or rows without a payroll number

        const nomina = String(row[0]).trim();
        const cognom1 = row[1] || '';
        const cognom2 = row[2] || '';
        const nom = row[3] || '';

        const phones = [row[4], row[5], row[6]]
            .filter(phone => phone) // Filter out null/undefined
            .map(phone => String(phone).trim()); // Convert to string and trim

        if (nomina) {
            db.phonebook.set(nomina, {
                nomina,
                nom,
                cognom1,
                cognom2,
                phones
            });
        }
    }
};