// Random sci-fi pilot names for the new-game wizard. Players can edit the
// generated name freely; the dice button rerolls. Two short pools combined
// (~3500 unique permutations) so the dice roll feels fresh without us
// having to ship a giant dictionary.

const FIRST = [
  "Mara", "Vex", "Ridley", "Sigi", "Cobb", "Renn", "Astrid", "Kade",
  "Juno", "Ezra", "Nyla", "Soren", "Iris", "Tarek", "Lin", "Orin",
  "Saskia", "Dax", "Nova", "Kai", "Lior", "Rhea", "Beren", "Mika",
  "Quinn", "Vesper", "Theo", "Anya", "Yusuf", "Wren", "Cass", "Hale",
  "Imogen", "Rook", "Pell", "Asa", "Zara", "Brel", "Indra", "Calla",
  "Sten", "Nash", "Maris", "Ewan", "Faye", "Levi", "Otis", "Petra",
];

const LAST = [
  "Voss", "Kade", "Marche", "Aldren", "Soto", "Tanaka", "Holt", "Ferran",
  "Ivers", "Quill", "Branner", "Halberd", "Crowe", "Ostro", "Vance",
  "Barlow", "Merritt", "Sable", "Drexler", "Yew", "Ashford", "Bell",
  "Corso", "Devereux", "Ebon", "Fane", "Gale", "Hadrian", "Imari",
  "Jansen", "Kessler", "Larkin", "Morrow", "Niven", "Oren", "Pryce",
  "Quade", "Rylan", "Strand", "Telford", "Ulrich", "Vaughn", "Whitlock",
];

function pick<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

export function randomPilotName(): string {
  return `${pick(FIRST)} ${pick(LAST)}`;
}
