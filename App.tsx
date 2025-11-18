import React, { useState, useMemo, useCallback } from 'react';
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { processDataCSV, processServeiCSV, processDriverCSV, processDriverPDF, readFileAsText, processPhonebookXLSX } from './services/csvParser.ts';
import Modal from './components/Modal.tsx';
import type { Shift, Circulation, Driver, Db, Overlap, ComparisonResultData, CirculationInShift, PhonebookEntry, PresenceInterval } from './types.ts';


// Helper functions for time calculation
const timeToMinutes = (timeStr: string): number => {
    try {
        const [hours, minutes] = timeStr.split(':').map(Number);
        if (isNaN(hours) || isNaN(minutes)) return 0;
        return (hours * 60) + minutes;
    } catch {
        return 0;
    }
};

const minutesToTime = (minutes: number): string => {
    const totalMinutes = Math.round(minutes); // Ensure integer minutes
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const timeDifferenceInMinutes = (startStr: string, endStr: string): number => {
    if (!startStr || !endStr) return 0;
    try {
        let startMinutes = timeToMinutes(startStr);
        let endMinutes = timeToMinutes(endStr);
        if (endMinutes < startMinutes) {
            endMinutes += 24 * 60;
        }
        return endMinutes - startMinutes;
    } catch (e) {
        console.error("Could not parse time for difference calculation", startStr, endStr, e);
        return 0;
    }
};

// Helper function to get train phone number
const getTrainPhoneNumber = (trainNum: string): string | null => {
    if (!trainNum || !trainNum.includes('.')) return null;
    
    const parts = trainNum.split('.');
    if (parts.length !== 2) return null;

    const [series, unitStr] = parts;
    const unit = parseInt(unitStr, 10);
    if (isNaN(unit)) return null;

    switch (series) {
        case '112':
            return `692${unit + 50}`;
        case '113':
            return `694${unitStr.padStart(2, '0')}`;
        case '114':
            return `694${unit + 50}`;
        case '115':
            return `697${unitStr.padStart(2, '0')}`;
        default:
            return null;
    }
};

const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64String = reader.result as string;
            // The result includes the data URL prefix 'data:...;base64,', remove it
            resolve(base64String.split(',')[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
};

const convertTrainCodeToNumber = (code: string): string | null => {
    if (!/^\d{3}$/.test(code)) return null;
    const seriesPrefix = code.charAt(0);
    const unit = code.substring(1);
    let series: string;

    switch (seriesPrefix) {
        case '2': series = '112'; break;
        case '3': series = '113'; break;
        case '4': series = '114'; break;
        case '5': series = '115'; break;
        default: return null;
    }
    return `${series}.${unit}`;
};

// --- Special Shift ID Helpers ---
const SPECIAL_PREFIXES = ['P', 'S', 'N'];

// Converts Q0P02 -> QP02, Q0S02 -> QS02, etc. Also Q0F00 -> QF00
const getBaseShiftId = (serviceId: string): string => {
    if (!serviceId || !serviceId.startsWith('Q') || serviceId.length < 4) {
        return serviceId;
    }
    const serviceDigit = serviceId.charAt(1);
    const prefix = serviceId.charAt(2);
    if ((serviceDigit === '0' || serviceDigit === '1') && SPECIAL_PREFIXES.includes(prefix)) {
        return `Q${serviceId.substring(2)}`;
    }
    if (serviceId === 'Q0F00' || serviceId === 'Q1F00') {
        return 'QF00';
    }
    return serviceId;
};

// Converts QP02 + service '0' -> Q0P02. Also QF00 + service '0' -> Q0F00
const getServiceSpecificShiftId = (baseId: string, service: string): string => {
    if (!baseId || !baseId.startsWith('Q') || baseId.length < 3) {
        return baseId;
    }
    // service '0' is Dl-Dj, service '100' is Dv
    const serviceDigit = service === '100' ? '1' : '0';
    const prefix = baseId.charAt(1);
    
    if (SPECIAL_PREFIXES.includes(prefix)) {
        // e.g., QP02 -> Q0P02
        return `Q${serviceDigit}${baseId.substring(1)}`;
    }
    if (baseId === 'QF00') {
        return `Q${serviceDigit}F00`;
    }
    return baseId;
};

// Icon Components for reusability
const PhoneIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 inline-block mr-1 text-gray-600 group-hover:text-blue-600 transition" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
    </svg>
);

const BookIcon = () => (
     <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 inline-block mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
    </svg>
);

const App: React.FC = () => {
    const [activeTab, setActiveTab] = useState('load');
    const [db, setDb] = useState<Db | null>(null);
    const [assignments, setAssignments] = useState<Map<string, string>>(new Map());

    const [loadStatus, setLoadStatus] = useState({ message: '', type: 'info' });
    const [assignStatus, setAssignStatus] = useState({ message: '', type: 'info' });
    const [imageAssignStatus, setImageAssignStatus] = useState({ message: '', type: 'info' });
    
    const [modal, setModal] = useState<{isOpen: boolean, title: string, content: React.ReactNode | null}>({ isOpen: false, title: '', content: null });

    const [searchService, setSearchService] = useState('0');
    const [searchType, setSearchType] = useState('turno');

    // Search inputs state
    const [turnoInput, setTurnoInput] = useState('');
    const [circInput, setCircInput] = useState('');
    const [cycleInput, setCycleInput] = useState('');
    const [stationInput, setStationInput] = useState('');
    const [timeStartInput, setTimeStartInput] = useState('');
    const [timeEndInput, setTimeEndInput] = useState('');
    const [driverInput, setDriverInput] = useState('');
    const [driverSuggestions, setDriverSuggestions] = useState<{ tornId: string; driver: Driver }[]>([]);
    
    // This state is set on each search action to pass a stable time to result components
    const [lastSearchTime, setLastSearchTime] = useState<Date | null>(null);

    const [searchResults, setSearchResults] = useState<React.ReactNode>(
        <p className="text-gray-500 text-center mt-16">Els resultats de la cerca apareixeran aquí.</p>
    );
    
    // Organize Turns state
    const [organizeTorn1, setOrganizeTorn1] = useState('');
    const [organizeTorn2, setOrganizeTorn2] = useState('');
    const [comparisonResult, setComparisonResult] = useState<ComparisonResultData | string | null>(null);
    
    // Agenda state
    const [agendaSearch, setAgendaSearch] = useState('');


    const sortedCycles = useMemo(() => db ? [...db.allCycleIds].sort((a, b) => a.localeCompare(b)) : [], [db]);
    const sortedStations = useMemo(() => db ? [...db.allStations].sort((a, b) => a.localeCompare(b)) : [], [db]);

    const handleLoadData = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const form = e.target as HTMLFormElement;
        const dataFile = (form.elements.namedItem('dataFileInput') as HTMLInputElement).files?.[0];
        const serveiFiles = (form.elements.namedItem('serveiFilesInput') as HTMLInputElement).files;
        const driverFile = (form.elements.namedItem('driverFileInput') as HTMLInputElement).files?.[0];
        const phonebookFile = (form.elements.namedItem('phonebookFileInput') as HTMLInputElement).files?.[0];

        if (!dataFile || !serveiFiles || serveiFiles.length === 0 || !driverFile || !phonebookFile) {
            setModal({ isOpen: true, title: 'Error de Càrrega', content: <p>Si us plau, selecciona els quatre tipus de fitxers.</p> });
            return;
        }

        setLoadStatus({ message: 'Processant...', type: 'info' });

        try {
            // FIX: Explicitly type the Maps and Sets on initialization to prevent them from being `Map<any, any>`.
            // This ensures proper type inference throughout the application when accessing the db state.
            const newDb: Db = {
                shifts: new Map<string, Shift>(),
                circulations: new Map<string, Circulation>(),
                drivers: new Map<string, Driver[]>(),
                phonebook: new Map<string, PhonebookEntry>(),
                allCycleIds: new Set<string>(),
                allStations: new Set<string>()
            };
            
            const dataContent = await readFileAsText(dataFile);
            processDataCSV(dataContent, newDb);

            const serveiContents = await Promise.all(Array.from(serveiFiles).map(file => readFileAsText(file)));
            serveiContents.forEach(content => processServeiCSV(content, newDb));

            if (driverFile.name.toLowerCase().endsWith('.pdf')) {
                await processDriverPDF(driverFile, newDb);
            } else {
                const driverContent = await readFileAsText(driverFile);
                processDriverCSV(driverContent, newDb);
            }

            await processPhonebookXLSX(phonebookFile, newDb);

            setDb(newDb);
            setLoadStatus({ message: `Dades carregades amb èxit! (${newDb.shifts.size} torns, ${newDb.circulations.size} circulacions, ${newDb.drivers.size} maquinistes, ${newDb.phonebook.size} contactes)`, type: 'success' });
            setActiveTab('assign');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
            setLoadStatus({ message: `Error: ${errorMessage}`, type: 'error' });
            setModal({ isOpen: true, title: 'Error de Càrrega', content: <><p>Hi va haver un problema en processar els fitxers.</p><p className="text-sm text-red-700">{errorMessage}</p></> });
        }
    };
    
    const handleAssignCycle = () => {
        const cycleId = (document.getElementById('cycleAssignSelect') as HTMLSelectElement).value;
        const trainNum = (document.getElementById('trainNumInput') as HTMLInputElement).value.trim();

        if (!cycleId || !trainNum) {
            setAssignStatus({ message: 'Si us plau, selecciona un cicle i introdueix un número de tren.', type: 'error' });
            return;
        }

        for (const [c, t] of assignments.entries()) {
            if (t === trainNum && c !== cycleId) {
                setAssignStatus({ message: `Error: El tren ${trainNum} ja està assignat al cicle ${c}.`, type: 'error' });
                return;
            }
        }
        
        const newAssignments = new Map(assignments);
        newAssignments.set(cycleId, trainNum);
        setAssignments(newAssignments);
        setAssignStatus({ message: `Cicle ${cycleId} assignat al Tren ${trainNum} amb èxit.`, type: 'success' });
    };

    const handleRemoveAssignment = (cycleId: string) => {
        const newAssignments = new Map(assignments);
        newAssignments.delete(cycleId);
        setAssignments(newAssignments);
        setAssignStatus({ message: `Assignació del cicle ${cycleId} eliminada.`, type: 'info' });
    };
    
    const handleImageAssign = async (file: File) => {
        if (!file) {
            setImageAssignStatus({ message: 'Si us plau, selecciona un fitxer d\'imatge.', type: 'error' });
            return;
        }
        if (!process.env.API_KEY) {
            setImageAssignStatus({ message: 'API Key no configurada. Aquesta funció no està disponible.', type: 'error' });
            return;
        }

        setImageAssignStatus({ message: 'Processant imatge amb IA...', type: 'info' });

        try {
            const base64Data = await blobToBase64(file);

            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            
            const prompt = `From the provided image of a train control screen, extract pairings of cycle IDs and train number codes.
The screen shows a grid. In each cell of the grid, there's a block of information for a train.
This block contains:
- A 3-digit train number code at the top-center (e.g., 308, 509).
- An alphanumeric cycle ID below it (e.g., RERB1, N2PN1).

Your task is to identify these pairs.
Return the result as a JSON array of objects. Each object must have two keys: "cycleId" and "trainCode".
The trainCode must be a string of 3 digits. The cycleId is alphanumeric.
Example format: [{"cycleId": "RERB1", "trainCode": "308"}, {"cycleId": "N2PN1", "trainCode": "509"}]
Only include entries where you can clearly identify both a train code and its corresponding cycle ID in a single block. Ignore blocks where information is missing or unclear.`;

            const response: GenerateContentResponse = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: {
                    parts: [
                        { inlineData: { mimeType: file.type, data: base64Data } },
                        { text: prompt },
                    ],
                },
                config: {
                    responseMimeType: 'application/json',
                    responseSchema: {
                        type: 'ARRAY',
                        items: {
                            type: 'OBJECT',
                            properties: {
                                cycleId: { type: 'STRING' },
                                trainCode: { type: 'STRING' },
                            },
                            required: ['cycleId', 'trainCode'],
                        },
                    },
                },
            });
            
            const jsonText = response.text.trim();
            const extractedData: { cycleId: string; trainCode: string }[] = JSON.parse(jsonText);

            if (!extractedData || extractedData.length === 0) {
                 setImageAssignStatus({ message: 'No s\'han pogut extreure dades de la imatge.', type: 'error' });
                 return;
            }

            const newAssignments = new Map(assignments);
            let assignmentsAdded = 0;
            let assignmentsOverwritten = 0;

            for (const item of extractedData) {
                const trainNum = convertTrainCodeToNumber(item.trainCode);
                if (trainNum && item.cycleId && db?.allCycleIds.has(item.cycleId)) {
                    if (newAssignments.has(item.cycleId)) {
                        assignmentsOverwritten++;
                    } else {
                        assignmentsAdded++;
                    }
                    newAssignments.set(item.cycleId, trainNum);
                }
            }
            
            setAssignments(newAssignments);
            setImageAssignStatus({ message: `Assignacions processades: ${assignmentsAdded} afegides, ${assignmentsOverwritten} sobreescrites. Total: ${newAssignments.size}.`, type: 'success' });

        } catch (error) {
            console.error("Error processing image with Gemini:", error);
            const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
            setImageAssignStatus({ message: `Error en processar la imatge: ${errorMessage}`, type: 'error' });
        }
    };

    const isTimeInRange = (timeStr: string, startStr: string, endStr: string) => {
        try {
            const format = (t: string) => t.split(':').slice(0, 2).join(':');
            const time = format(timeStr);
            const start = format(startStr);
            const end = format(endStr);
            
            if (start <= end) return time >= start && time <= end;
            return time >= start || time <= end;
        } catch(e) {
            console.warn("Error comparing time:", timeStr, startStr, endStr, e);
            return false;
        }
    };
    
    const getActiveShifts = useCallback((): Shift[] => {
        if (!db) return [];
        // FIX: Cast the result of Array.from to the correct type as inference is failing.
        const allShifts = Array.from(db.shifts.values()) as Shift[];
        if (!searchService) return allShifts;
        return allShifts.filter(shift => shift.servei === searchService);
    }, [db, searchService]);
    
    const showPassingTimes = (circId: string) => {
        if (!db) return;
        const circ = db.circulations.get(circId);
        if (!circ) {
            setModal({ isOpen: true, title: 'Error', content: <p>No es van trobar dades d'horari per a aquesta circulació.</p> });
            return;
        }
        setModal({
            isOpen: true,
            title: `Horari de Pas: ${circId} (${circ.inici} \u2192 ${circ.final})`,
            content: <PassingTimesTable circ={circ} />
        });
    };

    // --- Search Handlers ---
    const handleSearchTorn = (tornIdOverride?: string) => {
        if (!db) return;
        const searchTimestamp = new Date();
        setLastSearchTime(searchTimestamp); 
        const tornToSearch = tornIdOverride || turnoInput;
        if (!tornToSearch) return;

        const userInputId = tornToSearch.trim().toUpperCase();
        
        // A list of possible IDs to check, in order of priority.
        const possibleIds = [
            getServiceSpecificShiftId(userInputId, searchService), // e.g., converts QP02 -> Q0P02
            userInputId, // User might have typed the full ID Q0P02
            userInputId.startsWith('Q') && /^\d+$/.test(userInputId.substring(1)) ? 'Q' + userInputId.substring(1).padStart(4, '0') : null // Normalize standard IDs like Q1 -> Q0001
        ].filter((id): id is string => id !== null); // Remove nulls and create a clean string array

        let shift: Shift | undefined;
        for (const id of possibleIds) {
            shift = db.shifts.get(id);
            if (shift) break;
        }
        
        if (!shift || (searchService && shift.servei !== searchService)) {
             let errorMsg = `Torn "${tornToSearch}" no trobat.`;
             if (shift && searchService) {
                errorMsg = `El Torn "${tornToSearch}" existeix, però pertany al servei ${shift.servei}, no al servei ${searchService} seleccionat.`;
            }
            setSearchResults(<p className="text-red-600 text-center mt-16">{errorMsg}</p>);
            return;
        }
        
        // The driver data should be keyed by the same ID as the shift data.
        const drivers = db.drivers.get(shift.id);
        setSearchResults(<TornResult shift={shift} drivers={drivers} assignments={assignments} showPassingTimes={showPassingTimes} phonebook={db.phonebook} searchTime={searchTimestamp} />);
    };
    
    const handleSearchCirc = () => {
        if (!db || !circInput) return;
        const searchTimestamp = new Date(); // Use a local var to prevent state lag
        setLastSearchTime(searchTimestamp);
        const circId = circInput.trim().toUpperCase();
        const circ = db.circulations.get(circId);

        if (!circ) {
            setSearchResults(<p className="text-red-600 text-center mt-16">Circulació "{circId}" no trobada.</p>);
            return;
        }

        const activeShifts = getActiveShifts();
        let foundShift: Shift | null = null;
        let foundCicle = '';
        for (const shift of activeShifts) {
            const c = shift.circulations.find(c => c.codi === circId);
            if (c) {
                foundShift = shift;
                foundCicle = c.cicle;
                break;
            }
        }
        
        if (!foundShift) {
            let errorMsg = `Circulació "${circId}" trobada, però no assignada a cap torn.`;
            if (searchService) {
                 errorMsg = `Circulació "${circId}" trobada, però no assignada a cap torn del servei ${searchService} seleccionat.`;
            }
            setSearchResults(<p className="text-red-600 text-center mt-16">{errorMsg}</p>);
            return;
        }
        
        const drivers = db.drivers.get(foundShift.id);
        setSearchResults(<CircResult circ={circ} shift={foundShift} cicle={foundCicle} assignments={assignments} drivers={drivers} phonebook={db.phonebook} />);
    };

    const handleSearchCycle = () => {
        if (!db || !cycleInput) return;
        const cycleId = cycleInput;
        const activeShifts = getActiveShifts();
        
        let circsInCycle: Circulation[] = [];
        for (const shift of activeShifts) {
            for (const circ of shift.circulations) {
                if (circ.cicle === cycleId) {
                    const circData = db.circulations.get(circ.codi);
                    if (circData) circsInCycle.push(circData);
                }
            }
        }
        
        circsInCycle.sort((a, b) => a.sortida.localeCompare(b.sortida));
        setSearchResults(<CycleResult cycleId={cycleId} circulations={circsInCycle} assignments={assignments} showPassingTimes={showPassingTimes} />);
    };

    const handleSearchStation = () => {
        if (!db || !stationInput || !timeStartInput || !timeEndInput) {
             setSearchResults(<p className="text-red-600 text-center mt-16">Si us plau, selecciona estació, hora d'inici i hora de fi.</p>);
            return;
        }

        const foundEvents: { shift: Shift; reason: string; eventTime: string }[] = [];
        const activeShifts = getActiveShifts();
        
        // Find shifts starting or ending at the station in the time range
        for (const shift of activeShifts) {
            if (shift.dependencia === stationInput) {
                if (isTimeInRange(shift.iniciTorn, timeStartInput, timeEndInput)) {
                    foundEvents.push({
                        shift,
                        reason: `Inici de torn a ${stationInput} a les ${shift.iniciTorn}`,
                        eventTime: shift.iniciTorn
                    });
                }
                if (isTimeInRange(shift.finalTorn, timeStartInput, timeEndInput)) {
                     foundEvents.push({
                        shift,
                        reason: `Fi de torn a ${stationInput} a les ${shift.finalTorn}`,
                        eventTime: shift.finalTorn
                    });
                }
            }
        }
        
        // Find circulations passing through the station in the time range
        for (const circ of db.circulations.values()) {
            const passingStation = circ.estacions.find(e => e.nom === stationInput);
            let stationTime: string | null = null, reason = '';
            
            if (circ.inici === stationInput && isTimeInRange(circ.sortida, timeStartInput, timeEndInput)) {
                stationTime = circ.sortida; reason = `Inicia circ. ${circ.id} a ${stationInput} a les ${stationTime}`;
            } else if (circ.final === stationInput && isTimeInRange(circ.arribada, timeStartInput, timeEndInput)) {
                stationTime = circ.arribada; reason = `Finalitza circ. ${circ.id} a ${stationInput} a les ${stationTime}`;
            } else if (passingStation && isTimeInRange(passingStation.hora, timeStartInput, timeEndInput)) {
                stationTime = passingStation.hora; reason = `Passa circ. ${circ.id} per ${stationInput} a les ${stationTime}`;
            }

            if (stationTime) {
                for (const shift of activeShifts) {
                    if (shift.circulations.some(c => c.codi === circ.id)) {
                        foundEvents.push({ shift, reason, eventTime: stationTime });
                        break;
                    }
                }
            }
        }
        
        // Sort all found events by time, handling overnight ranges
        const startSearchMinutes = timeToMinutes(timeStartInput);
        const isOvernightSearch = timeToMinutes(timeEndInput) < startSearchMinutes;

        foundEvents.sort((a, b) => {
            let aMinutes = timeToMinutes(a.eventTime);
            let bMinutes = timeToMinutes(b.eventTime);

            if (isOvernightSearch) {
                // If the time is numerically smaller than the start time, it's on the next day
                if (aMinutes < startSearchMinutes) aMinutes += 24 * 60;
                if (bMinutes < startSearchMinutes) bMinutes += 24 * 60;
            }

            return aMinutes - bMinutes;
        });

        setSearchResults(<StationResult station={stationInput} startTime={timeStartInput} endTime={timeEndInput} foundEvents={foundEvents} drivers={db.drivers} onShiftClick={(tornId) => { setSearchType('turno'); setTurnoInput(tornId); handleSearchTorn(tornId); }} />);
    };
    
    const handleDriverInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setDriverInput(value);

        if (value.length < 2 || !db) {
            setDriverSuggestions([]);
            return;
        }

        const lowerCaseValue = value.toLowerCase();
        const suggestions: { tornId: string; driver: Driver }[] = [];
        // This search logic assumes one driver per shift entry, which is ok for suggestions.
        // We'll search the full list of drivers.
        for (const [tornId, drivers] of db.drivers.entries()) {
            for (const driver of drivers) {
                if (driver.nom.toLowerCase().includes(lowerCaseValue) || driver.nomina.includes(lowerCaseValue)) {
                    suggestions.push({ tornId, driver });
                }
            }
        }
        setDriverSuggestions(suggestions.slice(0, 10)); // Limit suggestions
    };

    const handleSuggestionClick = (tornId: string, driver: Driver) => {
        if (!db) return;
        const searchTimestamp = new Date();
        setLastSearchTime(searchTimestamp);
        setDriverInput(`${driver.nom} (${driver.nomina})`);
        setDriverSuggestions([]);
        
        const shift = db.shifts.get(tornId);
        if (!shift) {
            setSearchResults(<p className="text-red-600 text-center mt-16">Error: S'ha trobat el maquinista però el seu torn assignat ({tornId}) no existeix a les dades.</p>);
            return;
        }
        if (searchService && shift.servei !== searchService) {
            setSearchResults(<p className="text-red-600 text-center mt-16">El torn d'aquest maquinista pertany al servei {shift.servei}, no al servei {searchService} seleccionat.</p>);
            return;
        }

        const allDriversForShift = db.drivers.get(tornId);
        setSearchResults(
            <DriverResult 
                driver={driver} 
                shift={shift} 
                allDriversForShift={allDriversForShift}
                phonebook={db.phonebook}
                assignments={assignments} 
                showPassingTimes={showPassingTimes}
                searchTime={searchTimestamp}
            />
        );
    };

    const handleSearchDriver = () => {
        if (!db || !driverInput) return;
        
        // If there are suggestions, use the top one as the most likely match
        if (driverSuggestions.length > 0) {
            handleSuggestionClick(driverSuggestions[0].tornId, driverSuggestions[0].driver);
            return;
        }

        // If no suggestions are visible (e.g., user typed full name and hit enter), do a manual search
        const lowerCaseInput = driverInput.toLowerCase().trim();
        let found: { tornId: string; driver: Driver } | null = null;
        for (const [tornId, drivers] of db.drivers.entries()) {
            for (const driver of drivers) {
                 if (driver.nom.toLowerCase().includes(lowerCaseInput) || driver.nomina.includes(lowerCaseInput)) {
                    found = { tornId, driver };
                    break; // Use the first match
                }
            }
            if (found) break;
        }
        if (found) {
            handleSuggestionClick(found.tornId, found.driver);
        } else {
            setSearchResults(<p className="text-red-600 text-center mt-16">No s'ha trobat cap maquinista que coincideixi amb "{driverInput}".</p>);
        }
    };


    // --- Organize Turns Handlers ---
    const getPresenceIntervals = useCallback((shift: Shift): PresenceInterval[] => {
        if (!db) return [];
        const TARGET_STATIONS = ['PC', 'SR', 'PN', 'NA'];
        const intervals: PresenceInterval[] = [];

        const shiftStartMinutes = timeToMinutes(shift.iniciTorn);

        const sortedCircsWithData = shift.circulations
            .map(c => ({ shiftCirc: c, circData: db.circulations.get(c.codi) }))
            .filter((item): item is { shiftCirc: CirculationInShift; circData: Circulation } => !!item.circData)
            .sort((a, b) => {
                let aMinutes = timeToMinutes(a.shiftCirc.sortida);
                let bMinutes = timeToMinutes(b.shiftCirc.sortida);
                if (aMinutes < shiftStartMinutes) aMinutes += 24 * 60;
                if (bMinutes < shiftStartMinutes) bMinutes += 24 * 60;
                return aMinutes - bMinutes;
            });

        if (sortedCircsWithData.length === 0) {
            if (TARGET_STATIONS.includes(shift.dependencia)) {
                intervals.push({
                    station: shift.dependencia,
                    startMinutes: timeToMinutes(shift.iniciTorn),
                    endMinutes: timeToMinutes(shift.finalTorn),
                    startTime: shift.iniciTorn,
                    endTime: shift.finalTorn,
                    startReason: `Inici Torn a ${shift.dependencia}`,
                    endReason: `Final Torn a ${shift.dependencia}`
                });
            }
        } else {
            const firstCirc = sortedCircsWithData[0];
            if (shift.dependencia === firstCirc.circData.inici && TARGET_STATIONS.includes(shift.dependencia)) {
                intervals.push({
                    station: shift.dependencia,
                    startMinutes: timeToMinutes(shift.iniciTorn),
                    endMinutes: timeToMinutes(firstCirc.shiftCirc.sortida),
                    startTime: shift.iniciTorn,
                    endTime: firstCirc.shiftCirc.sortida,
                    startReason: `Inici Torn a ${shift.dependencia}`,
                    endReason: `Sortida Circ. ${firstCirc.circData.id}`
                });
            }

            for (let i = 0; i < sortedCircsWithData.length - 1; i++) {
                const current = sortedCircsWithData[i];
                const next = sortedCircsWithData[i + 1];
                if (current.circData.final === next.circData.inici && TARGET_STATIONS.includes(current.circData.final)) {
                    intervals.push({
                        station: current.circData.final,
                        startMinutes: timeToMinutes(current.shiftCirc.arribada),
                        endMinutes: timeToMinutes(next.shiftCirc.sortida),
                        startTime: current.shiftCirc.arribada,
                        endTime: next.shiftCirc.sortida,
                        startReason: `Arribada Circ. ${current.circData.id}`,
                        endReason: `Sortida Circ. ${next.circData.id}`
                    });
                }
            }

            const lastCirc = sortedCircsWithData[sortedCircsWithData.length - 1];
            if (lastCirc.circData.final === shift.dependencia && TARGET_STATIONS.includes(shift.dependencia)) {
                intervals.push({
                    station: shift.dependencia,
                    startMinutes: timeToMinutes(lastCirc.shiftCirc.arribada),
                    endMinutes: timeToMinutes(shift.finalTorn),
                    startTime: lastCirc.shiftCirc.arribada,
                    endTime: shift.finalTorn,
                    startReason: `Arribada Circ. ${lastCirc.circData.id}`,
                    endReason: `Final Torn a ${shift.dependencia}`
                });
            }
        }
        
        const isOvernightShift = timeToMinutes(shift.finalTorn) < shiftStartMinutes;
        
        return intervals.map(interval => {
            let { startMinutes, endMinutes } = interval;
            if (isOvernightShift) {
                if (startMinutes < shiftStartMinutes) startMinutes += 24 * 60;
                if (endMinutes < shiftStartMinutes) endMinutes += 24 * 60;
            }
            if (endMinutes < startMinutes) {
                endMinutes += 24 * 60;
            }
            return { ...interval, startMinutes, endMinutes };
        }).filter(i => i.endMinutes > i.startMinutes);
    }, [db]);
    
    const handleCompareShifts = () => {
        if (!db) return;
        
        const normalize = (id: string) => {
            const upperId = id.trim().toUpperCase();
            return upperId.startsWith('Q') && /^\d+$/.test(upperId.substring(1)) ? 'Q' + upperId.substring(1).padStart(4, '0') : upperId;
        }

        const id1 = normalize(organizeTorn1);
        const id2 = normalize(organizeTorn2);


        if (!id1 || !id2) {
            setComparisonResult("Introdueix els dos torns a comparar.");
            return;
        }
        if (id1 === id2) {
            setComparisonResult("No es poden comparar el mateix torn.");
            return;
        }

        const shift1 = db.shifts.get(id1);
        const shift2 = db.shifts.get(id2);

        if (!shift1 || !shift2) {
            setComparisonResult(`No s'ha trobat un o tots dos torns (${!shift1 ? organizeTorn1 : ''} ${!shift2 ? organizeTorn2 : ''}).`);
            return;
        }

        const intervals1 = getPresenceIntervals(shift1);
        const intervals2 = getPresenceIntervals(shift2);
        const overlaps: Overlap[] = [];

        for (const int1 of intervals1) {
            for (const int2 of intervals2) {
                if (int1.station === int2.station) {
                    const overlapStart = Math.max(int1.startMinutes, int2.startMinutes);
                    const overlapEnd = Math.min(int1.endMinutes, int2.endMinutes);

                    if (overlapStart < overlapEnd) {
                        overlaps.push({
                            station: int1.station,
                            start: minutesToTime(overlapStart),
                            end: minutesToTime(overlapEnd),
                        });
                    }
                }
            }
        }
        
        const getLastCirculation = (shift: Shift): CirculationInShift | null => {
            if (shift.circulations.length === 0) return null;
            
            const shiftStartMinutes = timeToMinutes(shift.iniciTorn);
            
            const sorted = [...shift.circulations].sort((a, b) => {
                // We use arrival time to determine the "last" circulation of the shift
                let aMinutes = timeToMinutes(a.arribada);
                let bMinutes = timeToMinutes(b.arribada);
                
                if (aMinutes < shiftStartMinutes) aMinutes += 24 * 60;
                if (bMinutes < shiftStartMinutes) bMinutes += 24 * 60;
                
                return aMinutes - bMinutes;
            });
            
            return sorted[sorted.length - 1];
        };

        const lastCirculation1 = getLastCirculation(shift1);
        const lastCirculation2 = getLastCirculation(shift2);
            
        setComparisonResult({ shift1, shift2, overlaps, intervals1, intervals2, lastCirculation1, lastCirculation2 });
    };

    
    // UI Helpers
    const tabClasses = (tab: string) => `py-3 px-4 text-sm sm:text-base font-medium border-b-4 transition-colors whitespace-nowrap ${activeTab === tab ? 'text-[#99cc33] border-[#99cc33] font-black' : 'text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300'}`;
    const btnPrimary = "bg-[#58595b] text-white font-ultrabold py-2 px-6 rounded-lg shadow-md border-2 border-[#58595b] transition-all duration-200 hover:scale-[1.02] hover:shadow-lg hover:shadow-gray-500/50 disabled:opacity-50 disabled:cursor-not-allowed";
    const btnSecondary = "bg-white text-[#58595b] font-ultrabold py-1 px-3 rounded-lg shadow-sm border-2 border-[#99cc33] transition-transform duration-200 hover:scale-[1.02] hover:bg-gray-50";
    const inputStyled = "w-full p-2 border-2 border-gray-300 rounded-lg bg-gray-200 focus:border-[#99cc33] focus:ring-1 focus:ring-[#99cc33] outline-none transition-all";

    return (
        <>
            <header className="bg-[#99cc33] text-white p-4 shadow-lg">
                <div className="container mx-auto max-w-7xl flex items-center space-x-4">
                    <img src="https://www.fgc.cat/wp-content/uploads/2020/06/logo-FGC-square.png" alt="FGC Logo" className="h-10 w-10 sm:h-12 sm:w-12"/>
                    <h1 className="text-2xl sm:text-3xl font-ultrabold text-white">Cercador de Torns FGC</h1>
                </div>
            </header>

            <main className="container mx-auto max-w-7xl p-4 sm:p-8">
                <div className="mb-6 border-b border-gray-300">
                    <div className="overflow-x-auto tabs-scroll-container">
                        <nav className="flex -mb-px space-x-4 min-w-max">
                            <button onClick={() => setActiveTab('load')} className={tabClasses('load')}>
                                <span className="sm:hidden">1. Dades</span>
                                <span className="hidden sm:inline">1. Carregar Dades</span>
                            </button>
                            <button onClick={() => setActiveTab('assign')} disabled={!db} className={tabClasses('assign')}>
                                <span className="sm:hidden">2. Cicles</span>
                                <span className="hidden sm:inline">2. Assignar Cicles</span>
                            </button>
                            <button onClick={() => setActiveTab('search')} disabled={!db} className={tabClasses('search')}>
                                <span className="sm:hidden">3. Cercar</span>
                                <span className="hidden sm:inline">3. Cercar</span>
                            </button>
                            <button onClick={() => setActiveTab('organize')} disabled={!db} className={tabClasses('organize')}>
                                <span className="sm:hidden">4. Organitzar</span>
                                <span className="hidden sm:inline">4. Organitza Torns</span>
                            </button>
                            <button onClick={() => setActiveTab('agenda')} disabled={!db} className={tabClasses('agenda')}>
                                <span className="sm:hidden">5. Agenda</span>
                                <span className="hidden sm:inline">5. Agenda</span>
                            </button>
                        </nav>
                    </div>
                </div>

                {activeTab === 'load' && (
                    <div className="space-y-6">
                        <div className="bg-white p-6 rounded-lg shadow-md">
                            <h2 className="text-2xl font-ultrabold mb-4">Carregar Fitxers</h2>
                            <form onSubmit={handleLoadData} >
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div className="space-y-2">
                                        <label htmlFor="dataFileInput" className="block font-ultrabold">1. Fitxer de Torns (data.csv)</label>
                                        <input type="file" id="dataFileInput" name="dataFileInput" accept=".csv" className={inputStyled} required/>
                                    </div>
                                    <div className="space-y-2">
                                        <label htmlFor="serveiFilesInput" className="block font-ultrabold">2. Fitxers de Servei (ServeiXXX.csv)</label>
                                        <input type="file" id="serveiFilesInput" name="serveiFilesInput" accept=".csv" multiple className={inputStyled} required/>
                                        <p className="text-xs text-gray-500">Pots seleccionar múltiples fitxers.</p>
                                    </div>
                                    <div className="space-y-2">
                                        <label htmlFor="driverFileInput" className="block font-ultrabold">3. Fitxer de Maquinistes (.csv o .pdf)</label>
                                        <input type="file" id="driverFileInput" name="driverFileInput" accept=".csv,.pdf" className={inputStyled} required/>
                                    </div>
                                    <div className="space-y-2">
                                        <label htmlFor="phonebookFileInput" className="block font-ultrabold">4. Fitxer d'Agenda (telefons.xlsx)</label>
                                        <input type="file" id="phonebookFileInput" name="phonebookFileInput" accept=".xlsx" className={inputStyled} required/>
                                    </div>
                                </div>
                                <div className="mt-6 text-center">
                                    <button type="submit" className={`${btnPrimary} w-full md:w-auto`}>Carregar i Processar Dades</button>
                                </div>
                            </form>
                            <div className={`mt-4 text-center font-medium ${loadStatus.type === 'success' ? 'text-green-600' : loadStatus.type === 'error' ? 'text-red-600' : ''}`}>{loadStatus.message}</div>
                        </div>
                    </div>
                )}
                
                {activeTab === 'assign' && (
                    <div className="space-y-6">
                        <div className="bg-white p-6 rounded-lg shadow-md">
                            <h2 className="text-2xl font-ultrabold mb-4">Assignar Tren a Cicle</h2>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
                                <div className="space-y-2">
                                    <label htmlFor="cycleAssignSelect" className="block font-ultrabold">Cicle</label>
                                    <select id="cycleAssignSelect" className={inputStyled}>
                                        <option value="">Selecciona un cicle</option>
                                        {sortedCycles.map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                                <div className="space-y-2">
                                    <label htmlFor="trainNumInput" className="block font-ultrabold">Núm. de Tren</label>
                                    <input type="text" id="trainNumInput" placeholder="112.03" className={inputStyled} />
                                </div>
                                <div className="space-y-2">
                                    <button onClick={handleAssignCycle} className={`${btnPrimary} w-full`}>Assignar Tren</button>
                                </div>
                            </div>
                            <div className={`mt-4 text-center font-medium ${assignStatus.type === 'success' ? 'text-green-600' : assignStatus.type === 'error' ? 'text-red-600' : ''}`}>{assignStatus.message}</div>
                        </div>
                        
                        <div className="bg-white p-6 rounded-lg shadow-md">
                            <h3 className="text-xl font-ultrabold mb-4">Assignar des d'una Imatge (Beta)</h3>
                            <p className="text-sm text-gray-600 mb-4">Puja una captura de pantalla del panell de control per assignar automàticament els trens als cicles. La IA interpretarà la imatge.</p>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
                                <div className="md:col-span-2 space-y-2">
                                    <label htmlFor="imageAssignInput" className="block font-ultrabold">Fitxer d'Imatge</label>
                                    <input type="file" id="imageAssignInput" accept="image/*" className={inputStyled} />
                                </div>
                                <button 
                                    onClick={() => {
                                        const fileInput = document.getElementById('imageAssignInput') as HTMLInputElement;
                                        if (fileInput.files && fileInput.files[0]) {
                                            handleImageAssign(fileInput.files[0]);
                                        } else {
                                            setImageAssignStatus({ message: 'Si us plau, selecciona un fitxer.', type: 'error' });
                                        }
                                    }} 
                                    className={`${btnPrimary} w-full`}
                                >
                                    Processar Imatge
                                </button>
                            </div>
                            <div className={`mt-4 text-center font-medium ${imageAssignStatus.type === 'success' ? 'text-green-600' : imageAssignStatus.type === 'error' ? 'text-red-600' : ''}`}>{imageAssignStatus.message}</div>
                        </div>

                        <div className="bg-white p-6 rounded-lg shadow-md">
                            <h3 className="text-xl font-ultrabold mb-4">Assignacions Actuals</h3>
                            <div className="max-h-60 overflow-y-auto space-y-2">
                                {assignments.size === 0 ? <p className="text-gray-500">Encara no hi ha assignacions.</p> :
                                <ul className="divide-y divide-gray-200">
                                    {Array.from(assignments.entries()).map(([cycleId, trainNum]) => (
                                        <li key={cycleId} className="py-3 flex justify-between items-center">
                                            <div>
                                                <span className="font-ultrabold">{cycleId}</span>
                                                <span className="text-gray-500 ml-2">({trainNum})</span>
                                            </div>
                                            <button onClick={() => handleRemoveAssignment(cycleId)} className={`${btnSecondary} py-1 px-3 text-sm`}>Treure</button>
                                        </li>
                                    ))}
                                </ul>
                                }
                            </div>
                        </div>
                    </div>
                )}
                
                {activeTab === 'search' && (
                    <div className="space-y-6">
                         <div className="bg-white p-6 rounded-lg shadow-md">
                            <h2 className="text-2xl font-ultrabold mb-4">Cercador</h2>
                             <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                                <div>
                                    <label htmlFor="searchServiceSelect" className="block font-ultrabold mb-2">Servei</label>
                                    <select id="searchServiceSelect" value={searchService} onChange={e => setSearchService(e.target.value)} className={inputStyled}>
                                        <option value="">Tots</option>
                                        <option value="0">Servei 000 (Dl-Dj)</option>
                                        <option value="100">Servei 100 (Dv)</option>
                                    </select>
                                </div>
                                <div>
                                    <label htmlFor="searchType" className="block font-ultrabold mb-2">Tipus de Cerca</label>
                                    <select id="searchType" value={searchType} onChange={e => {setSearchType(e.target.value); setSearchResults(<p className="text-gray-500 text-center mt-16">Els resultats de la cerca apareixeran aquí.</p>);}} className={inputStyled}>
                                        <option value="turno">Cercar per Torn</option>
                                        <option value="circulacion">Cercar per Circulació</option>
                                        <option value="ciclo">Cercar per Cicle</option>
                                        <option value="estacion">Cercar per Estació/Hora</option>
                                        <option value="maquinista">Cercar per Maquinista</option>
                                    </select>
                                </div>
                             </div>

                            {searchType === 'turno' && (
                                <form onSubmit={e => {e.preventDefault(); handleSearchTorn();}} className="space-y-4">
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                                        <div className="md:col-span-2 space-y-2">
                                            <label htmlFor="turnoSearchInput" className="block font-ultrabold">ID del Torn</label>
                                            <input type="text" id="turnoSearchInput" value={turnoInput} onChange={e => setTurnoInput(e.target.value)} placeholder="Q0001 / QP02" className={inputStyled} />
                                        </div>
                                        <button type="submit" className={`${btnPrimary} w-full`}>Cercar Torn</button>
                                    </div>
                                </form>
                            )}
                            {searchType === 'circulacion' && (
                                <form onSubmit={e => {e.preventDefault(); handleSearchCirc();}} className="space-y-4">
                                     <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                                        <div className="md:col-span-2 space-y-2">
                                            <label htmlFor="circSearchInput" className="block font-ultrabold">ID de Circulació</label>
                                            <input type="text" id="circSearchInput" value={circInput} onChange={e => setCircInput(e.target.value)} placeholder="F801" className={inputStyled} />
                                        </div>
                                        <button type="submit" className={`${btnPrimary} w-full`}>Cercar Circulació</button>
                                    </div>
                                </form>
                            )}
                            {searchType === 'ciclo' && (
                                <form onSubmit={e => {e.preventDefault(); handleSearchCycle();}} className="space-y-4">
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                                        <div className="md:col-span-2 space-y-2">
                                            <label htmlFor="cycleSearchSelect" className="block font-ultrabold">Cicle</label>
                                            <select id="cycleSearchSelect" value={cycleInput} onChange={e => setCycleInput(e.target.value)} className={inputStyled}>
                                                <option value="">Selecciona un cicle</option>
                                                {sortedCycles.map(c => <option key={c} value={c}>{c}</option>)}
                                            </select>
                                        </div>
                                        <button type="submit" className={`${btnPrimary} w-full`}>Cercar Cicle</button>
                                    </div>
                                </form>
                            )}
                            {searchType === 'estacion' && (
                                <form onSubmit={e => {e.preventDefault(); handleSearchStation();}} className="space-y-4">
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-end">
                                        <div className="space-y-2">
                                            <label htmlFor="stationSearchSelect" className="block font-ultrabold">Estació</label>
                                            <select id="stationSearchSelect" value={stationInput} onChange={e => setStationInput(e.target.value)} className={inputStyled}>
                                                <option value="">Selecciona una estació</option>
                                                {sortedStations.map(s => <option key={s} value={s}>{s}</option>)}
                                            </select>
                                        </div>
                                        <div className="flex gap-4">
                                            <div className="w-1/2 space-y-2">
                                                <label htmlFor="timeStartInput" className="block font-ultrabold">Des de</label>
                                                <input type="time" id="timeStartInput" value={timeStartInput} onChange={e => setTimeStartInput(e.target.value)} className={inputStyled} />
                                            </div>
                                            <div className="w-1/2 space-y-2">
                                                <label htmlFor="timeEndInput" className="block font-ultrabold">Fins a</label>
                                                <input type="time" id="timeEndInput" value={timeEndInput} onChange={e => setTimeEndInput(e.target.value)} className={inputStyled} />
                                            </div>
                                        </div>
                                    </div>
                                    <div className="text-center mt-4">
                                        <button type="submit" className={`${btnPrimary} w-full md:w-auto`}>Cercar a l'Estació</button>
                                    </div>
                                </form>
                            )}
                             {searchType === 'maquinista' && (
                                <form onSubmit={e => {e.preventDefault(); handleSearchDriver();}} className="space-y-4 relative">
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                                        <div className="md:col-span-2 space-y-2">
                                            <label htmlFor="driverSearchInput" className="block font-ultrabold">Nom, Cognoms o Nòmina del Maquinista</label>
                                            <input 
                                                type="text" 
                                                id="driverSearchInput" 
                                                value={driverInput} 
                                                onChange={handleDriverInputChange} 
                                                placeholder="John Doe" 
                                                className={inputStyled} 
                                                autoComplete="off"
                                            />
                                            {driverSuggestions.length > 0 && (
                                                <ul className="absolute z-10 w-full md:w-2/3 bg-white border border-gray-300 rounded-lg mt-1 max-h-60 overflow-y-auto shadow-lg">
                                                    {driverSuggestions.map(({ tornId, driver }) => (
                                                        <li 
                                                            key={`${tornId}-${driver.nomina}`} 
                                                            className="p-2 hover:bg-gray-100 cursor-pointer"
                                                            onClick={() => handleSuggestionClick(tornId, driver)}
                                                        >
                                                            {driver.nom} ({driver.nomina}) - Torn: {tornId}
                                                        </li>
                                                    ))}
                                                </ul>
                                            )}
                                        </div>
                                        <button type="submit" className={`${btnPrimary} w-full`}>Cercar Maquinista</button>
                                    </div>
                                </form>
                            )}
                         </div>
                         <div className="bg-white p-6 rounded-lg shadow-md min-h-[300px] search-results overflow-y-auto">
                           {searchResults}
                         </div>
                    </div>
                )}
                
                {activeTab === 'organize' && (
                     <div className="space-y-6">
                        <div className="bg-white p-6 rounded-lg shadow-md">
                            <h2 className="text-2xl font-ultrabold mb-4">Comparador de Torns</h2>
                            <p className="text-sm text-gray-600 mb-4">Selecciona dos torns per visualitzar les seves estades a les dependències clau (PC, SR, PN, NA) i trobar coincidències horàries.</p>
                            <form onSubmit={e => { e.preventDefault(); handleCompareShifts(); }} className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
                                <div className="space-y-2">
                                    <label htmlFor="organizeTorn1" className="block font-ultrabold">Torn 1</label>
                                    <input type="text" id="organizeTorn1" value={organizeTorn1} onChange={e => setOrganizeTorn1(e.target.value)} placeholder="Q0001" className={inputStyled} />
                                </div>
                                 <div className="space-y-2">
                                    <label htmlFor="organizeTorn2" className="block font-ultrabold">Torn 2</label>
                                    <input type="text" id="organizeTorn2" value={organizeTorn2} onChange={e => setOrganizeTorn2(e.target.value)} placeholder="Q0002" className={inputStyled} />
                                </div>
                                <button type="submit" className={`${btnPrimary} w-full`}>Comparar Torns</button>
                            </form>
                        </div>
                        <div className="bg-white p-6 rounded-lg shadow-md">
                            <h3 className="text-xl font-ultrabold mb-4">Visualització de Torns i Coincidències</h3>
                            {typeof comparisonResult === 'string' ? (
                                <p className="text-red-600 text-center">{comparisonResult}</p>
                            ) : comparisonResult ? (
                                <ComparisonResultView data={comparisonResult} db={db!} />
                            ) : (
                                <p className="text-gray-500 text-center">Els resultats de la comparació apareixeran aquí.</p>
                            )}
                        </div>
                    </div>
                )}
                
                 {activeTab === 'agenda' && (
                    <div className="bg-white p-6 rounded-lg shadow-md">
                        <h2 className="text-2xl font-ultrabold mb-4">Agenda Telefònica</h2>
                         <div className="mb-4">
                            <label htmlFor="agendaSearchInput" className="block font-ultrabold mb-2">Cercar per Nom, Cognom o Nòmina</label>
                            <input 
                                type="text" 
                                id="agendaSearchInput" 
                                value={agendaSearch} 
                                onChange={e => setAgendaSearch(e.target.value)} 
                                placeholder="Cerca a l'agenda..." 
                                className={inputStyled} 
                                autoComplete="off"
                            />
                        </div>
                        <PhonebookView phonebook={db!.phonebook} searchTerm={agendaSearch} />
                    </div>
                )}


            </main>
            
            <footer className="text-center py-4 mt-4 text-sm text-gray-500">
                FGC Shift Finder v1.7
            </footer>

            <Modal isOpen={modal.isOpen} onClose={() => setModal({ isOpen: false, title: '', content: null })} title={modal.title}>
                {modal.content}
            </Modal>
        </>
    );
};

// --- Result Components ---

interface TornResultProps {
    shift: Shift;
    drivers?: Driver[];
    assignments: Map<string, string>;
    showPassingTimes: (circId: string) => void;
    phonebook: Map<string, PhonebookEntry>;
    searchTime: Date;
}

const TornResult: React.FC<TornResultProps> = ({ shift, drivers, assignments, showPassingTimes, phonebook, searchTime }) => {
    
    const shiftStartMinutes = timeToMinutes(shift.iniciTorn);
    const isOvernightShift = timeToMinutes(shift.finalTorn) < shiftStartMinutes;

    // Helper to convert a time string (e.g., "01:15") into a minute value
    // on a continuous timeline that accounts for the shift crossing midnight.
    const normalizeMinutes = (timeStr: string): number => {
        let minutes = timeToMinutes(timeStr);
        // If the shift is overnight and the time's minute value is less than the start time's,
        // it means this time is on the "next day", so we add 24 hours worth of minutes.
        if (isOvernightShift && minutes < shiftStartMinutes) {
            minutes += 24 * 60;
        }
        return minutes;
    };

    // Build a unified itinerary with absolute start/end minutes for accurate "in-progress" checking.
    type ItineraryItem = 
        | { type: 'circulation'; startMinutes: number; endMinutes: number; data: CirculationInShift; }
        | { type: 'interval'; startMinutes: number; endMinutes: number; data: { duration: number; type: 'Descans' | 'Temps' } };

    const itinerary: ItineraryItem[] = [];
    let lastKnownTime = shift.iniciTorn;

    // Sort circulations chronologically, correctly handling overnight shifts.
    const sortedCirculations = [...shift.circulations].sort((a, b) => {
        return normalizeMinutes(a.sortida) - normalizeMinutes(b.sortida);
    });

    sortedCirculations.forEach(circ => {
        const intervalDuration = timeDifferenceInMinutes(lastKnownTime, circ.sortida);
        if (intervalDuration > 0) {
            itinerary.push({
                type: 'interval',
                startMinutes: normalizeMinutes(lastKnownTime),
                endMinutes: normalizeMinutes(circ.sortida),
                data: { duration: intervalDuration, type: intervalDuration >= 15 ? 'Descans' : 'Temps' },
            });
        }
        itinerary.push({
            type: 'circulation',
            startMinutes: normalizeMinutes(circ.sortida),
            endMinutes: normalizeMinutes(circ.arribada),
            data: circ,
        });
        lastKnownTime = circ.arribada;
    });

    const finalIntervalDuration = timeDifferenceInMinutes(lastKnownTime, shift.finalTorn);
    if (finalIntervalDuration > 0) {
        itinerary.push({
            type: 'interval',
            startMinutes: normalizeMinutes(lastKnownTime),
            endMinutes: normalizeMinutes(shift.finalTorn),
            data: { duration: finalIntervalDuration, type: finalIntervalDuration >= 15 ? 'Descans' : 'Temps' },
        });
    }

    // Convert search time to the same continuous minute timeline.
    let searchMinutes = searchTime.getHours() * 60 + searchTime.getMinutes();
    if (isOvernightShift && searchMinutes < shiftStartMinutes) {
        searchMinutes += 24 * 60;
    }
    
    // Find the index of the currently active item.
    const activeIndex = itinerary.findIndex(item => 
        searchMinutes >= item.startMinutes && searchMinutes < item.endMinutes
    );

    const InfoCard = ({ title, value }: { title: string, value: string }) => (
        <div className="bg-gray-100 p-3 rounded-lg text-center shadow-sm">
            <p className="text-sm text-gray-500 font-bold">{title}</p>
            <p className="text-lg font-ultrabold">{value}</p>
        </div>
    );
    
    const ItineraryInterval = ({ interval, isActive }: { interval: ItineraryItem & { type: 'interval' }, isActive: boolean }) => {
        const { duration, type } = interval.data;
        const isDescans = type === 'Descans';
        const currentTimeStr = minutesToTime(searchMinutes);

        return (
            <div className={`p-3 border-t border-gray-200 text-center italic ${isDescans ? 'bg-green-100' : 'bg-orange-100'}`}>
                <div className="flex items-center justify-center">
                    {isActive && (
                         <span 
                            className="w-3 h-3 bg-red-500 rounded-full mr-3 flex-shrink-0 animate-pulse" 
                            title={`En curs a les ${currentTimeStr}`}
                        ></span>
                    )}
                    <span className={`font-bold ${isDescans ? 'text-green-800' : 'text-orange-800'}`}>
                        {type}: {minutesToTime(duration)}
                    </span>
                </div>
            </div>
        );
    };

    return (
        <div className="space-y-6">
            <div className="text-center pb-4 border-b-2 border-gray-200">
                <p className="text-sm text-gray-500">Torn</p>
                <h2 className="text-2xl font-ultrabold text-[#58595b]">{shift.id}</h2>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <InfoCard title="Servei" value={shift.servei} />
                <InfoCard title="Duració" value={shift.duracio} />
                <InfoCard title="Inici Torn" value={shift.iniciTorn} />
                <InfoCard title="Final Torn" value={shift.finalTorn} />
                <InfoCard title="Dependència" value={shift.dependencia} />
            </div>

            {drivers && drivers.length > 0 && (
                <div>
                    <h3 className="text-xl font-ultrabold mb-3">Maquinistes Assignats</h3>
                    <div className="space-y-4">
                        {drivers.map(driver => {
                            const contact = phonebook.get(driver.nomina);
                            const cleanObservations = driver.observacions?.replace(/\b(N|S)\b/g, '').trim();
                            return (
                                <div key={driver.nomina} className="bg-gray-50 p-4 rounded-lg">
                                    <div className="flex justify-between items-center">
                                        <div>
                                            <p className="font-bold">{driver.nom}
                                                {cleanObservations && <span className="text-sm text-gray-600 font-normal ml-2">({cleanObservations})</span>}
                                            </p>
                                            <p className="text-sm text-gray-500">Nòmina: {driver.nomina}</p>
                                        </div>
                                    </div>
                                    {contact && contact.phones.length > 0 && (
                                        <div className="mt-2 pt-2 border-t border-gray-200 flex flex-wrap gap-4">
                                            {contact.phones.map(phone => (
                                                <a key={phone} href={`tel:${phone}`} className="text-blue-600 hover:underline flex items-center group">
                                                    <PhoneIcon />
                                                    <span className="ml-1">{phone}</span>
                                                </a>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
            
            <div>
                <h3 className="text-xl font-ultrabold mb-3">Contingut del torn</h3>
                <div className="rounded-lg border border-gray-200">
                    <div className="hidden md:flex text-xs font-bold text-gray-500 uppercase bg-gray-100">
                        <div className="flex-1 p-3">Circulació</div>
                        <div className="w-24 p-3 text-center">Sortida</div>
                        <div className="w-24 p-3 text-center">Arribada</div>
                        <div className="flex-1 p-3 text-center">Cicle</div>
                        <div className="w-32 p-3 text-center">Unitat</div>
                        <div className="w-48 p-3 text-center">Llibre d'Itineraris</div>
                    </div>
                    <div>
                        {itinerary.map((item, index) => {
                            const isActive = index === activeIndex;
                            const currentTimeStr = minutesToTime(searchMinutes);
                            
                            if (item.type === 'interval') {
                                return <ItineraryInterval key={index} interval={item} isActive={isActive} />;
                            }
                            
                            // Item is a circulation
                            const circ = item.data;
                            const trainNum = assignments.get(circ.cicle);
                            const trainPhone = trainNum ? getTrainPhoneNumber(trainNum) : null;
                            
                            let circulationDisplay = circ.codi;
                            let realCircCodeForButton = circ.codi;
                            const isViatger = circ.codi.toUpperCase() === 'VIATGER';

                            if (isViatger) {
                                if (circ.observacions && circ.observacions.trim()) {
                                    const obsTrimmed = circ.observacions.trim();
                                    circulationDisplay = `Viatger ${obsTrimmed}`;
                                    
                                    const match = obsTrimmed.match(/^([a-zA-Z0-9]+)/);
                                    if (match && match[1]) {
                                        realCircCodeForButton = match[1];
                                    } else {
                                        realCircCodeForButton = '';
                                    }
                                } else {
                                    circulationDisplay = 'Viatger (detalls no disponibles)';
                                    realCircCodeForButton = '';
                                }
                            }
                            
                            return (
                                <div key={index} className="flex flex-col md:flex-row md:items-center p-3 border-t border-gray-200 bg-white">
                                    <div className="flex-1 mb-2 md:mb-0 flex items-center">
                                        {isActive && (
                                            <span 
                                                className="w-3 h-3 bg-red-500 rounded-full mr-3 flex-shrink-0 animate-pulse" 
                                                title={`En curs a les ${currentTimeStr}`}
                                            ></span>
                                        )}
                                        <div>
                                            <span className="font-bold md:hidden">Circulació: </span>
                                            <span className={`font-ultrabold text-lg ${isViatger ? 'text-blue-600' : 'text-[#58595b]'}`}>
                                                {circulationDisplay}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="w-full md:w-24 md:text-center mb-2 md:mb-0">
                                        <span className="font-bold md:hidden">Sortida: </span>
                                        <span className="font-normal">{circ.sortida}</span>
                                    </div>
                                    <div className="w-full md:w-24 md:text-center mb-2 md:mb-0">
                                        <span className="font-bold md:hidden">Arribada: </span>
                                        <span className="font-normal">{circ.arribada}</span>
                                    </div>
                                    <div className="flex-1 md:text-center mb-2 md:mb-0">
                                        <span className="font-bold md:hidden">Cicle: </span>
                                        <span className="text-sm font-normal">{circ.cicle}</span>
                                    </div>
                                    <div className="w-full md:w-32 md:text-center mb-2 md:mb-0">
                                        <span className="font-bold md:hidden">Unitat: </span>
                                        {trainNum && !isViatger ? (
                                            trainPhone ? (
                                                <a href={`tel:${trainPhone}`} className="text-blue-600 hover:underline font-bold inline-flex items-center group">
                                                    <PhoneIcon /> {trainNum}
                                                </a>
                                            ) : <span className="font-semibold">{trainNum}</span>
                                        ) : <span className="text-gray-400">-</span>}
                                    </div>
                                    <div className="w-full md:w-48 flex md:justify-center">
                                         <button 
                                            onClick={() => showPassingTimes(realCircCodeForButton)} 
                                            className="bg-white text-xs w-full md:w-auto text-[#58595b] font-ultrabold py-2 px-3 rounded-md shadow-sm border border-[#99cc33] hover:bg-gray-50 flex items-center justify-center whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                                            disabled={!realCircCodeForButton}
                                        >
                                           <BookIcon /> Llibre d'Itineraris
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
};


interface CircResultProps {
    circ: Circulation;
    shift: Shift;
    cicle: string;
    assignments: Map<string, string>;
    drivers?: Driver[];
    phonebook: Map<string, PhonebookEntry>;
}

const CircResult: React.FC<CircResultProps> = ({ circ, shift, cicle, assignments, drivers, phonebook }) => {
    const baseShiftId = getBaseShiftId(shift.id);
    return (
        <div>
            <h3 className="text-xl font-ultrabold mb-2">Detalls de la Circulació: {circ.id}</h3>
            <div className="mb-4 p-4 bg-gray-100 rounded-lg space-y-2">
                <p><strong>Línia:</strong> {circ.linia}</p>
                <p><strong>Recorregut:</strong> {circ.inici} ({circ.sortida}) &rarr; {circ.final} ({circ.arribada})</p>
                <p><strong>Assignada al Torn:</strong> {shift.id} {baseShiftId !== shift.id && `(${baseShiftId})`}</p>
                 {drivers && drivers.length > 0 && (
                    <div>
                        <strong>Maquinistes del Torn:</strong>
                         <ul className="list-disc list-inside ml-2">
                            {drivers.map(driver => {
                                const contact = phonebook.get(driver.nomina);
                                return (
                                    <li key={driver.nomina}>
                                        {driver.nom} ({driver.nomina})
                                        {contact && contact.phones.length > 0 && (
                                            <div className="inline-block ml-2 tooltip-container">
                                                <PhoneIcon />
                                                <div className="tooltip-text">
                                                    {contact.phones.join(' / ')}
                                                </div>
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                )}
                <p><strong>Cicle:</strong> {cicle}</p>
                {assignments.has(cicle) && <p><strong>Tren Assignat:</strong> {assignments.get(cicle)}</p>}
            </div>
            <PassingTimesTable circ={circ} />
        </div>
    );
};

interface CycleResultProps {
    cycleId: string;
    circulations: Circulation[];
    assignments: Map<string, string>;
    showPassingTimes: (circId: string) => void;
}

const CycleResult: React.FC<CycleResultProps> = ({ cycleId, circulations, assignments, showPassingTimes }) => {
    const trainNum = assignments.get(cycleId);
    return (
        <div>
            <h3 className="text-xl font-ultrabold mb-2">Detalls del Cicle: {cycleId}</h3>
            {trainNum && <p className="mb-4 p-4 bg-gray-100 rounded-lg"><strong>Tren Assignat:</strong> {trainNum}</p>}
            <h4 className="text-lg font-ultrabold mb-2">Circulacions en aquest cicle:</h4>
            <ul className="space-y-3">
                {circulations.map(circ => (
                     <li key={circ.id} className="p-3 bg-gray-50 rounded-lg shadow-sm flex justify-between items-center">
                        <div>
                            <p className="font-bold">{circ.id}</p>
                            <p className="text-sm text-gray-600">{circ.inici} ({circ.sortida}) &rarr; {circ.final} ({circ.arribada})</p>
                        </div>
                        <button onClick={() => showPassingTimes(circ.id)} className="bg-white text-xs text-[#58595b] font-ultrabold py-1 px-2 rounded-md shadow-sm border border-[#99cc33] hover:bg-gray-50">
                            Veure Horari
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
};

interface StationResultProps {
    station: string;
    startTime: string;
    endTime: string;
    foundEvents: { shift: Shift; reason: string; eventTime: string }[];
    drivers: Map<string, Driver[]>;
    onShiftClick: (tornId: string) => void;
}

const StationResult: React.FC<StationResultProps> = ({ station, startTime, endTime, foundEvents, drivers, onShiftClick }) => {
    if (foundEvents.length === 0) {
        return <p className="text-gray-500 text-center">No s'han trobat torns o circulacions a {station} entre les {startTime} i les {endTime}.</p>;
    }

    return (
        <div>
            <h3 className="text-xl font-ultrabold mb-4">Resultats per l'Estació {station} ({startTime} - {endTime})</h3>
            <ul className="space-y-4">
                {foundEvents.map((event, index) => {
                    const shiftDrivers = drivers.get(event.shift.id);
                    const baseShiftId = getBaseShiftId(event.shift.id);
                    return (
                        <li key={`${event.shift.id}-${event.eventTime}-${index}`} className="bg-gray-100 p-4 rounded-lg shadow-sm">
                            <p className="text-sm font-semibold text-[#99cc33] mb-2">{event.reason}</p>
                            <div className="flex justify-between items-center">
                                <button onClick={() => onShiftClick(event.shift.id)} className="text-left hover:underline">
                                    <h4 className="text-lg font-ultrabold">
                                        Torn: {event.shift.id} {baseShiftId !== event.shift.id && `(${baseShiftId})`}
                                    </h4>
                                </button>
                                <span className="text-sm text-gray-600">{event.shift.iniciTorn} - {event.shift.finalTorn} ({event.shift.duracio})</span>
                            </div>
                            {shiftDrivers && shiftDrivers.length > 0 && (
                                <p className="text-sm mt-1">Maquinista: {shiftDrivers.map(d => `${d.nom} (${d.nomina})`).join(', ')}</p>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
};

interface DriverResultProps {
    driver: Driver;
    shift: Shift;
    allDriversForShift?: Driver[];
    assignments: Map<string, string>;
    showPassingTimes: (circId: string) => void;
    phonebook: Map<string, PhonebookEntry>;
    searchTime: Date;
}

const DriverResult: React.FC<DriverResultProps> = ({ driver, shift, allDriversForShift, assignments, showPassingTimes, phonebook, searchTime }) => {
    const baseShiftId = getBaseShiftId(shift.id);
    return (
        <div>
            <h3 className="text-xl font-ultrabold mb-2">Resultat per Maquinista</h3>
            <div className="mb-4 p-4 bg-gray-100 rounded-lg">
                <p><strong>Maquinista:</strong> {driver.nom} ({driver.nomina})</p>
                <p><strong>Torn assignat:</strong> {shift.id} {baseShiftId !== shift.id && `(${baseShiftId})`}</p>
            </div>
            <TornResult 
                shift={shift} 
                drivers={allDriversForShift}
                assignments={assignments} 
                showPassingTimes={showPassingTimes}
                phonebook={phonebook}
                searchTime={searchTime}
            />
        </div>
    );
};


const PassingTimesTable: React.FC<{ circ: Circulation }> = ({ circ }) => {
    // Combine start/end with intermediate stations
    const allStops = [
        { nom: circ.inici, hora: circ.sortida },
        ...circ.estacions,
        { nom: circ.final, hora: circ.arribada }
    ];
    // Simple deduplication based on station name, keeping first occurrence
    const uniqueStops = allStops.filter((stop, index, self) =>
        index === self.findIndex((s) => s.nom === stop.nom)
    );

    return (
        <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-sm text-left">
                <thead className="text-xs uppercase bg-gray-200 sticky top-0">
                    <tr>
                        <th scope="col" className="px-6 py-3">Estació</th>
                        <th scope="col" className="px-6 py-3">Hora de Pas</th>
                    </tr>
                </thead>
                <tbody>
                    {uniqueStops.map((estacio, index) => (
                        <tr key={`${estacio.nom}-${index}`} className="bg-white border-b">
                            <td className="px-6 py-4 font-medium">{estacio.nom}</td>
                            <td className="px-6 py-4">{estacio.hora}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

interface PresenceBarProps {
    durationMinutes: number;
    startOffsetMinutes: number;
    maxDuration: number;
    color: string;
    children: React.ReactNode;
    tooltip: string;
    yOffset: string;
    opacity?: string;
}

const PresenceBar: React.FC<PresenceBarProps> = ({ durationMinutes, startOffsetMinutes, maxDuration, color, children, tooltip, yOffset, opacity = 'opacity-100' }) => {
    const width = (durationMinutes / maxDuration) * 100;
    const left = (startOffsetMinutes / maxDuration) * 100;

    return (
        <div
            className={`h-6 rounded absolute flex items-center justify-center text-white text-xs font-bold tooltip-container ${opacity}`}
            style={{ width: `${width}%`, left: `${left}%`, backgroundColor: color, top: yOffset }}
        >
            <span className="truncate px-1">{children}</span>
            <div className="tooltip-text">
                {tooltip}
            </div>
        </div>
    );
};

interface ComparisonResultViewProps {
    data: ComparisonResultData;
    db: Db;
}

const ComparisonResultView: React.FC<ComparisonResultViewProps> = ({ data, db }) => {
    const { shift1, shift2, overlaps, intervals1, intervals2, lastCirculation1, lastCirculation2 } = data;

    const start1 = timeToMinutes(shift1.iniciTorn);
    const end1 = timeToMinutes(shift1.finalTorn) < start1 ? timeToMinutes(shift1.finalTorn) + 24 * 60 : timeToMinutes(shift1.finalTorn);
    const start2 = timeToMinutes(shift2.iniciTorn);
    const end2 = timeToMinutes(shift2.finalTorn) < start2 ? timeToMinutes(shift2.finalTorn) + 24 * 60 : timeToMinutes(shift2.finalTorn);

    const overallStart = Math.min(start1, start2);
    const overallEnd = Math.max(end1, end2);
    const maxDuration = overallEnd - overallStart;

    const lastCircData1 = lastCirculation1 ? db.circulations.get(lastCirculation1.codi) : null;
    const lastCircData2 = lastCirculation2 ? db.circulations.get(lastCirculation2.codi) : null;
    
    const isReliefPossible = () => {
        if (!lastCirculation1 || !lastCirculation2 || !lastCircData1 || !lastCircData2) return false;
        const endStation1 = lastCircData1.final;
        const endStation2 = lastCircData2.final;
        if (endStation1 !== endStation2) return false;
        const arrivalTime1 = timeToMinutes(lastCirculation1.arribada);
        const arrivalTime2 = timeToMinutes(lastCirculation2.arribada);
        return Math.abs(arrivalTime1 - arrivalTime2) <= 15;
    };

    const stationColors: { [key: string]: string } = {
        PC: '#3b82f6', // blue-500
        SR: '#8b5cf6', // violet-500
        NA: '#f97316', // orange-500
        PN: '#16a34a', // green-600
    };
    const overlapColor = '#ef4444'; // red-500

    return (
        <div className="space-y-6">
            <div>
                 <h4 className="text-lg font-ultrabold mb-2">Línia de Temps dels Torns</h4>
                 <div className="relative h-20 bg-gray-200 rounded-lg p-2">
                    <PresenceBar
                        durationMinutes={end1 - start1}
                        startOffsetMinutes={start1 - overallStart}
                        maxDuration={maxDuration}
                        color="#3b82f6"
                        yOffset="0.5rem"
                        tooltip={`Torn ${shift1.id}: ${shift1.iniciTorn} - ${shift1.finalTorn}`}
                    >
                        Torn {shift1.id}
                    </PresenceBar>
                     <PresenceBar
                        durationMinutes={end2 - start2}
                        startOffsetMinutes={start2 - overallStart}
                        maxDuration={maxDuration}
                        color="#16a34a"
                        yOffset="2.5rem"
                        tooltip={`Torn ${shift2.id}: ${shift2.iniciTorn} - ${shift2.finalTorn}`}
                    >
                        Torn {shift2.id}
                    </PresenceBar>
                 </div>
                 <div className="flex justify-between text-xs mt-1 px-2">
                    <span>{minutesToTime(overallStart)}</span>
                    <span>{minutesToTime(overallEnd)}</span>
                </div>
            </div>
            
             <div>
                <h4 className="text-lg font-ultrabold mb-2">Estades a Dependències i Coincidències</h4>
                <div className="relative bg-gray-200 rounded-lg p-2 h-32">
                    <PresenceBar durationMinutes={end1 - start1} startOffsetMinutes={start1 - overallStart} maxDuration={maxDuration} color="#60a5fa" yOffset="0.5rem" opacity="opacity-30" tooltip={`Torn ${shift1.id}: ${shift1.iniciTorn} - ${shift1.finalTorn}`}>
                        {shift1.id}
                    </PresenceBar>
                    <PresenceBar durationMinutes={end2 - start2} startOffsetMinutes={start2 - overallStart} maxDuration={maxDuration} color="#4ade80" yOffset="2.5rem" opacity="opacity-30" tooltip={`Torn ${shift2.id}: ${shift2.iniciTorn} - ${shift2.finalTorn}`}>
                        {shift2.id}
                    </PresenceBar>
                    
                    {intervals1.map((iv, i) => (
                        <PresenceBar key={`s1-${i}`} durationMinutes={iv.endMinutes - iv.startMinutes} startOffsetMinutes={iv.startMinutes - overallStart} maxDuration={maxDuration} color={stationColors[iv.station] || '#6b7280'} yOffset="0.5rem" tooltip={`${iv.startReason} (${iv.startTime})\n${iv.endReason} (${iv.endTime})`}>
                            {iv.station}
                        </PresenceBar>
                    ))}
                     {intervals2.map((iv, i) => (
                         <PresenceBar key={`s2-${i}`} durationMinutes={iv.endMinutes - iv.startMinutes} startOffsetMinutes={iv.startMinutes - overallStart} maxDuration={maxDuration} color={stationColors[iv.station] || '#6b7280'} yOffset="2.5rem" tooltip={`${iv.startReason} (${iv.startTime})\n${iv.endReason} (${iv.endTime})`}>
                            {iv.station}
                        </PresenceBar>
                    ))}
                    {overlaps.map((o, i) => {
                        const oStart = timeToMinutes(o.start);
                        const oEnd = timeToMinutes(o.end);
                        if (oEnd < oStart) return null;
                         return ( <PresenceBar key={`o-${i}`} durationMinutes={oEnd - oStart} startOffsetMinutes={oStart - overallStart} maxDuration={maxDuration} color={overlapColor} yOffset="4.5rem" tooltip={`Coincidència a ${o.station}\n${o.start} - ${o.end}`}>
                            {o.station}
                        </PresenceBar> );
                    })}
                </div>
                <div className="flex justify-between text-xs mt-1 px-2">
                    <span>{minutesToTime(overallStart)}</span>
                    <span>{minutesToTime(overallEnd)}</span>
                </div>
                 <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm">
                    <div className="flex items-center space-x-2"><span className="w-3 h-3 bg-[#60a5fa] rounded-sm opacity-50"></span><span>Torn {shift1.id}</span></div>
                    <div className="flex items-center space-x-2"><span className="w-3 h-3 bg-[#4ade80] rounded-sm opacity-50"></span><span>Torn {shift2.id}</span></div>
                    <div className="flex items-center space-x-2"><span className="w-3 h-3 bg-[#ef4444] rounded-sm"></span><span>Coincidència</span></div>
                    <div className="flex items-center space-x-2"><span className="w-3 h-3 bg-[#3b82f6] rounded-sm"></span><span>PC</span></div>
                    <div className="flex items-center space-x-2"><span className="w-3 h-3 bg-[#8b5cf6] rounded-sm"></span><span>SR</span></div>
                    <div className="flex items-center space-x-2"><span className="w-3 h-3 bg-[#f97316] rounded-sm"></span><span>NA</span></div>
                    <div className="flex items-center space-x-2"><span className="w-3 h-3 bg-[#16a34a] rounded-sm"></span><span>PN</span></div>
                </div>
            </div>

            <div>
                <h4 className="text-lg font-ultrabold mb-2">Coincidències Detallades</h4>
                {overlaps.length > 0 ? (
                    <ul className="list-disc list-inside bg-green-50 p-4 rounded-lg">
                        {overlaps.map((o, i) => (
                            <li key={i}>
                                Coincidència a <span className="font-bold">{o.station}</span> de <span className="font-bold">{o.start}</span> a <span className="font-bold">{o.end}</span> ({timeDifferenceInMinutes(o.start, o.end)} min).
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-gray-500 bg-gray-50 p-4 rounded-lg">No s'han trobat coincidències horàries a les dependències clau.</p>
                )}
            </div>

            <div>
                <h4 className="text-lg font-ultrabold mb-2">Informació de Relleu</h4>
                <div className="bg-blue-50 p-4 rounded-lg text-sm space-y-2">
                    <p>
                        <strong>Torn {shift1.id}:</strong> 
                        {lastCirculation1 && lastCircData1 ? 
                            ` L'última circulació ({lastCirculation1.codi}) arriba a ${lastCircData1.final} a les ${lastCirculation1.arribada}.` :
                            ' No té circulacions.'
                        }
                    </p>
                     <p>
                        <strong>Torn {shift2.id}:</strong> 
                        {lastCirculation2 && lastCircData2 ? 
                            ` L'última circulació ({lastCirculation2.codi}) arriba a ${lastCircData2.final} a les ${lastCirculation2.arribada}.` :
                            ' No té circulacions.'
                        }
                    </p>
                    {isReliefPossible() && <p className="font-bold text-blue-800">Possible relleu entre torns a la mateixa estació i hora propera.</p>}
                </div>
            </div>
        </div>
    );
};

interface PhonebookViewProps {
    phonebook: Map<string, PhonebookEntry>;
    searchTerm: string;
}

const PhonebookView: React.FC<PhonebookViewProps> = ({ phonebook, searchTerm }) => {
    const filteredEntries = useMemo(() => {
        const lowerCaseSearch = searchTerm.toLowerCase().trim();
        if (!lowerCaseSearch) {
            return Array.from(phonebook.values());
        }
        return Array.from(phonebook.values()).filter(entry =>
            entry.nom.toLowerCase().includes(lowerCaseSearch) ||
            entry.cognom1.toLowerCase().includes(lowerCaseSearch) ||
            entry.cognom2.toLowerCase().includes(lowerCaseSearch) ||
            entry.nomina.includes(lowerCaseSearch)
        );
    }, [phonebook, searchTerm]);

    return (
        <div className="max-h-[60vh] overflow-y-auto p-1">
            {filteredEntries.length === 0 ? (
                <p className="text-center text-gray-500 mt-8">No s'han trobat coincidències.</p>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {filteredEntries.map(entry => (
                        <div key={entry.nomina} className="bg-white border border-gray-200 rounded-lg shadow-md p-4 flex flex-col justify-between transition-transform duration-200 hover:scale-[1.02] hover:shadow-lg">
                            <div>
                                <p className="font-ultrabold text-lg text-[#58595b] truncate">{`${entry.nom} ${entry.cognom1} ${entry.cognom2}`.trim()}</p>
                                <p className="text-sm text-gray-500 mb-3">Nòmina: {entry.nomina}</p>
                            </div>
                            <div className="border-t border-gray-200 pt-3 mt-auto space-y-2">
                                {entry.phones.length > 0 ? (
                                    entry.phones.map(phone => (
                                        <a 
                                            key={phone} 
                                            href={`tel:${phone}`} 
                                            className="flex items-center text-blue-600 hover:underline group text-sm"
                                        >
                                            <PhoneIcon /> 
                                            <span className="ml-2">{phone}</span>
                                        </a>
                                    ))
                                ) : (
                                    <p className="text-xs text-gray-400">Sense telèfons registrats.</p>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default App;
