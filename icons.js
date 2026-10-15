/* Eagle Creek — more line icons, and which icon goes with what.
 *
 * The same hand as the rest of the app's icons (24-point grid, 1.7 stroke, round ends, in the
 * spirit of the Mac's SF Symbols). Pages ask for an icon by what something is: a card's title,
 * a tile's label, a trade or budget category, a kind of file, an account type, a section.
 */
'use strict';

Object.assign(ICONS, {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.9v.01"/>',
  house: '<path d="M3.5 11.5 12 4.5l8.5 7"/><path d="M6 9.8V19.5h12V9.8"/><path d="M10 19.5v-5h4v5"/>',
  grid: '<rect x="4" y="4" width="6.6" height="6.6" rx="1.6"/><rect x="13.4" y="4" width="6.6" height="6.6" rx="1.6"/><rect x="4" y="13.4" width="6.6" height="6.6" rx="1.6"/><rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.6"/>',
  coins: '<ellipse cx="12" cy="6.5" rx="7" ry="2.7"/><path d="M5 6.5v5c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7v-5"/><path d="M5 11.5v5c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7v-5"/>',
  trend: '<path d="M3.5 17 9 11.5l3.5 3.5 8-8"/><path d="M15 7h5.5v5.5"/>',
  inbox: '<path d="M3.5 13.5 6.2 5.5h11.6l2.7 8V19a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/><path d="M3.5 13.5h4.8l1.2 2.3h5l1.2-2.3h4.8"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h3.5"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.5V12l3 2"/>',
  hourglass: '<path d="M6.5 3.5h11M6.5 20.5h11"/><path d="M8 3.5v2.8a4 4 0 0 0 4 4 4 4 0 0 0 4-4V3.5M8 20.5v-2.8a4 4 0 0 1 4-4 4 4 0 0 1 4 4v2.8"/>',
  note: '<path d="M5 4h14v10.5L13.5 20H5z"/><path d="M13.5 20v-5.5H19M8.5 8.5h7M8.5 12h4.5"/>',
  tag: '<path d="M3.5 12.3V4.5a1 1 0 0 1 1-1h7.8l8.7 8.7-8.8 8.8z"/><circle cx="8" cy="8" r="1.4"/>',
  logout: '<path d="M10 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H10"/><path d="m14.5 8 4 4-4 4M18.5 12H9.5"/>',
  device: '<rect x="6.5" y="3" width="11" height="18" rx="2.2"/><path d="M11 17.6h2"/>',
  key: '<circle cx="8" cy="15.5" r="4"/><path d="m10.9 12.6 8.6-8.6M16.4 7.1l2.6 2.6M14.2 9.3l1.8 1.8"/>',
  archive: '<rect x="3.5" y="4" width="17" height="4.5" rx="1"/><path d="M5 8.5v10.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M10 12.5h4"/>',
  funnel: '<path d="M4 5h16l-6 7.3v6.2l-4 2v-8.2z"/>',
  clipboard: '<rect x="5" y="4.5" width="14" height="16.5" rx="1.6"/><path d="M9 4.5V3h6v1.5M8.5 10h7M8.5 13.5h7M8.5 17h4"/>',
  hardhat: '<rect x="2.5" y="15.5" width="19" height="3.6" rx="1.2"/><path d="M10 10.6V5.4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5.2"/><path d="M4.6 15.5v-2.6A6.6 6.6 0 0 1 10 6.4M14 6.4a6.6 6.6 0 0 1 5.4 6.5v2.6"/>',
  // Weather
  cloud: '<path d="M7 18.5a4.5 4.5 0 1 1 1-8.9 5.5 5.5 0 0 1 10.6 1.6A3.7 3.7 0 0 1 17.5 18.5z"/>',
  cloudSun: '<path d="M9.5 19a3.8 3.8 0 1 1 .8-7.5 4.7 4.7 0 0 1 9 1.4 3.1 3.1 0 0 1-1 6.1z"/><path d="M8.2 8.6a3.3 3.3 0 0 0-4.6 3.9M6.5 3v1.6M2.3 5.3l1.1 1.1M10.7 5.3 9.6 6.4M1.5 9.5h1.6"/>',
  storm: '<path d="M7 16a4.5 4.5 0 1 1 1-8.9 5.5 5.5 0 0 1 10.6 1.6A3.7 3.7 0 0 1 17.5 16"/><path d="m12.5 12.5-2 4h3l-2 4"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="m9.8 4.6 2.2 1.8 2.2-1.8M9.8 19.4l2.2-1.8 2.2 1.8"/>',
  wind: '<path d="M3 9h11.5a2.5 2.5 0 1 0-2.4-3.2"/><path d="M3 13h16a2.5 2.5 0 1 1-2.4 3.2"/><path d="M3 17h7"/>',
  thermo: '<path d="M14 14.5V5a2 2 0 0 0-4 0v9.5a4 4 0 1 0 4 0z"/><path d="M12 9.5v7"/>',
  // Trades and rooms
  bolt: '<path d="M13 3 5.5 13.5H11L10 21l7.5-10.5H12z"/>',
  drop: '<path d="M12 3.5s-6 6.6-6 10.8a6 6 0 0 0 12 0c0-4.2-6-10.8-6-10.8z"/><path d="M9.3 14.6a2.8 2.8 0 0 0 2.6 2.7"/>',
  roof: '<path d="M2.5 13.2 12 5.5l9.5 7.7"/><path d="M5 11.3v8.2h14v-8.2"/><path d="M15.7 8.2V4.5h2.6v5.8"/>',
  roller: '<rect x="3.5" y="3.5" width="13.5" height="5.2" rx="1.6"/><path d="M17 6.1h2.5v5H11v3"/><rect x="9.5" y="14.1" width="3" height="6.6" rx="1"/>',
  fan: '<circle cx="12" cy="12" r="1.7"/><path d="M11.4 10.4C10.3 7 11.4 4 14 4c2 0 2.4 2.6.4 4.2-.9.8-1.8 1.5-2.9 2.2zM13.6 11.4c3.4-1.1 6.4 0 6.4 2.6 0 2-2.6 2.4-4.2.4-.8-.9-1.5-1.8-2.2-2.9zM12.6 13.6c1.1 3.4 0 6.4-2.6 6.4-2 0-2.4-2.6-.4-4.2.9-.8 1.8-1.5 2.9-2.2zM10.4 12.6C7 13.7 4 12.6 4 10c0-2 2.6-2.4 4.2-.4.8.9 1.5 1.8 2.2 2.9z"/>',
  layers: '<path d="M12 4 3 8.5l9 4.5 9-4.5z"/><path d="m3 12.5 9 4.5 9-4.5M3 16.5l9 4.5 9-4.5"/>',
  leaf: '<path d="M5.5 19C5 10.5 10 5 19.5 4.5c.5 9.5-5 14.5-13.2 14.5"/><path d="M5.5 19c2.8-4.2 5.8-6.8 9-8.5"/>',
  bricks: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 9.7h18M3 14.3h18M9.5 5v4.7M14.5 9.7v4.6M9.5 14.3V19"/>',
  window: '<rect x="5" y="3.5" width="14" height="17" rx="1.5"/><path d="M12 3.5v17M5 12h14"/>',
  door: '<path d="M6.5 21V4.5A1.5 1.5 0 0 1 8 3h8a1.5 1.5 0 0 1 1.5 1.5V21M4 21h16"/><path d="M14.3 12.3v.01"/>',
  bath: '<path d="M3 12h18v2.5a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z"/><path d="M6 12V6.2a2.2 2.2 0 0 1 4.1-1.1M7.5 19.5 6.5 21M16.5 19.5l1 1.5"/>',
  oven: '<rect x="4.5" y="3.5" width="15" height="17" rx="1.6"/><path d="M4.5 8.8h15M8 6.2h.01M11 6.2h.01M14 6.2h2.5"/><rect x="7.5" y="11.6" width="9" height="5.6" rx="1"/>',
  cabinet: '<rect x="4" y="4" width="16" height="16" rx="1.6"/><path d="M12 4v16M10 10.5v2M14 10.5v2"/>',
  bulb: '<path d="M9.2 18h5.6M10.2 21h3.6"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.1v.1h5v-.1c0-.8.4-1.6 1.1-2.1A6 6 0 0 0 12 3z"/>',
  sparkle: '<path d="M11 3.5 12.8 9l5.7 1.6-5.7 1.7L11 18l-1.8-5.7-5.7-1.7L9.2 9z"/><path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  truck: '<path d="M3 6.5h11v10H3zM14 9.5h4.2l2.8 3.4v3.6h-7"/><circle cx="7" cy="17.5" r="1.9"/><circle cx="17" cy="17.5" r="1.9"/>',
  shovel: '<path d="m14.4 9.6 4.9-4.9M17.2 3.2l3.6 3.6"/><path d="m12.6 7.8 3.6 3.6-5.6 5.6a3.6 3.6 0 0 1-5.1 0 3.6 3.6 0 0 1 0-5.1z"/>',
  // Travel
  forkKnife: '<path d="M6.5 3v5.2a2 2 0 0 0 4 0V3M8.5 3v18"/><path d="M17.5 21V3c-1.9 1.2-3.1 3.6-3.1 6.6 0 1.8.9 3.1 3.1 3.4"/>',
  bed: '<path d="M3 18.5V6M3 14.5h18v4M21 14.5v-2.3a2.7 2.7 0 0 0-2.7-2.7H11v5"/><circle cx="7" cy="11.5" r="2"/>',
  fuel: '<path d="M5 21V5a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 14 5v16M3.5 21h12M5 10h9"/><path d="M14 8.5h1.5A1.5 1.5 0 0 1 17 10v5.5a1.5 1.5 0 0 0 3 0V8l-2.5-2.5"/>',
  parking: '<rect x="4" y="4" width="16" height="16" rx="3.2"/><path d="M10 16.5V8h3.1a2.5 2.5 0 0 1 0 5H10"/>',
  laptop: '<rect x="5" y="5" width="14" height="9.5" rx="1.5"/><path d="M3 18.5h18"/>',
  handCoin: '<circle cx="15.5" cy="6.5" r="3"/><path d="M3 13.5h3.6l2.6 1h3.9a1.5 1.5 0 0 1 0 3H9.6"/><path d="m13.1 17.5 5.5-3a1.6 1.6 0 0 1 1.7 2.7L13.6 21H7.7L3 19.2"/>',
  dots: '<circle cx="6" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.35" fill="currentColor" stroke="none"/>',
});

/** The first icon whose pattern matches the text, else the fallback. */
function iconMatch(text, table, fallback = '') {
  const t = String(text || '');
  for (const [re, name] of table) if (re.test(t)) return name;
  return fallback;
}

// ----- Trades, rooms and budget categories (the Mac's are free text, so by keyword)

const TRADE_ICONS = [
  [/inspect/i, 'flag'],
  [/permit|engineer|survey|architect|design/i, 'clipboard'],
  [/electric|wiring|panel|low.?volt/i, 'bolt'],
  [/plumb|water heater|sewer|septic|well\b/i, 'drop'],
  [/hvac|heat|cool|air cond|furnace|duct|mechanical/i, 'fan'],
  [/roof|gutter|chimney/i, 'roof'],
  [/paint|stain|wallpaper/i, 'roller'],
  [/floor|carpet|lvp|hardwood|tile|grout/i, 'layers'],
  [/landscap|yard|lawn|tree|garden|sod|irrigat/i, 'leaf'],
  [/concrete|mason|brick|stone|stucco|foundation|footing|slab|block/i, 'bricks'],
  [/excavat|grading|site ?work|dirt|drain/i, 'shovel'],
  [/demo|haul|dumpster|debris|trash|deliver/i, 'truck'],
  [/window|glass|glaz|skylight/i, 'window'],
  [/door|garage|lock/i, 'door'],
  [/bath|shower|tub|toilet|vanit/i, 'bath'],
  [/kitchen|appliance|range|oven|fridge|refrigerat|dishwash/i, 'oven'],
  [/cabinet|counter|millwork|closet|shelv/i, 'cabinet'],
  [/light|fixture|fan install/i, 'bulb'],
  [/clean|punch|final|touch.?up|stag/i, 'sparkle'],
  [/drywall|insulat|siding|sheathing|exterior|interior/i, 'stack'],
  [/frame|framing|carpent|trim|deck|fenc|stair|lumber|wood/i, 'hammer'],
  [/acqui|purchase|closing|title/i, 'key'],
  [/loan|financ|interest|lender|bank/i, 'bank'],
  [/holding|utilit|insur|tax/i, 'shield'],
  [/selling|commission|market|listing|realtor/i, 'tag'],
  [/contingen/i, 'shield'],
  [/material|supplies|hardware/i, 'box'],
  [/labor|crew/i, 'hardhat'],
];
const tradeIcon = (text, fallback = 'wrench') => iconMatch(text, TRADE_ICONS, fallback);

// ----- Card titles (counts in brackets are ignored)

const CARD_ICONS = [
  [/^notes$|^memo$|^scope$/i, 'note'],
  [/^emails|gmail/i, 'mail'],
  [/^attachments/i, 'paperclip'],
  [/^files|proof of travel|^documents/i, 'paperclip'],
  [/^dates$/i, 'calendar'],
  [/^check$/i, 'checkCircle'],
  [/^details$|^contract$|^trip$|^summary$/i, 'info'],
  [/up next|coming up|starting soon|open work/i, 'clock'],
  [/needs attention/i, 'warn'],
  [/daily log/i, 'book'],
  [/punch/i, 'checklist'],
  [/schedule of values|continuation/i, 'listNumber'],
  [/change order|what changes|^changes$/i, 'branch'],
  [/subcontract|scope lines/i, 'signature'],
  [/selection/i, 'palette'],
  [/bills to pay|bills and expenses|bills against/i, 'receipt'],
  [/lien waiver|final waiver/i, 'seal'],
  [/invoices|owed to you|^income|other income/i, 'inbox'],
  [/money in and out|last 12 months|cash/i, 'chart'],
  [/bank and card|accounts$/i, 'bank'],
  [/eagle creek books/i, 'bookClosed'],
  [/^job costs$/i, 'hammer'],
  [/costs by account|job cost|budget vs actual|contract vs cost|^totals?$/i, 'coins'],
  [/gross profit|net income/i, 'trend'],
  [/recent activity|transactions|amounts|payments/i, 'list'],
  [/^projects|active projects/i, 'folder'],
  [/expenses/i, 'receipt'],
  [/^mileage/i, 'car'],
  [/trips not counted|^\d{4}\b/i, 'calendar'],
  [/cloud sync/i, 'sync'],
  [/appearance/i, 'palette'],
  [/home screen/i, 'share'],
  [/^account$/i, 'person'],
  [/this device/i, 'device'],
  [/^assets/i, 'box'],
  [/liabilit/i, 'receipt'],
  [/equity/i, 'person'],
  [/^vendors|^trades/i, 'wrench'],
  [/^customers/i, 'house'],
  [/^crew/i, 'hardhat'],
  [/^lenders/i, 'bank'],
  [/^other$/i, 'people'],
];
const cardIcon = (title) => iconMatch(String(title || '').replace(/\s*\([^)]*\)\s*$/, '').trim(), CARD_ICONS);

// ----- Tile labels

const TILE_ICONS = [
  [/waiver/i, 'seal'],
  [/days|weighted|365/i, 'globe'],
  [/trip/i, 'airplane'],
  [/meals/i, 'forkKnife'],
  [/mileage|driven|claimable|not posted/i, 'car'],
  [/contribut/i, 'handCoin'],
  [/paid personally|owes you/i, 'wallet'],
  [/hours/i, 'clock'],
  [/labor/i, 'hardhat'],
  [/schedule/i, 'schedule'],
  [/punch/i, 'checklist'],
  [/photos/i, 'image'],
  [/draw|funded|holdback/i, 'banknote'],
  [/profit|earned/i, 'trend'],
  [/so far/i, 'globe'],
  [/received|client owes|owed to you|they owe/i, 'inbox'],
  [/paid this year/i, 'banknote'],
  [/bills|spent|subs billed|you owe/i, 'receipt'],
  [/cash|balance|this year/i, 'bank'],
  [/left to bill|budget left|remaining/i, 'hourglass'],
  [/billed/i, 'doc'],
  [/contract|committed/i, 'signature'],
  [/budget/i, 'coins'],
  [/approved/i, 'checkCircle'],
  [/waiting/i, 'clock'],
  [/draft/i, 'edit'],
];
const tileIcon = (title) => iconMatch(title, TILE_ICONS);

// ----- Kinds of files, accounts and contacts

const FILE_ICONS = {
  propertyPhoto: 'image', progressPhoto: 'camera', invoice: 'doc', receipt: 'receipt', lienWaiver: 'seal', drawPaperwork: 'banknote',
  contractBid: 'signature', permitInspection: 'clipboard', closingTitle: 'key', loanDocument: 'bank', insurance: 'shield', plansSpecs: 'ruler',
  proposal: 'doc', changeOrder: 'branch', payApplication: 'listNumber', financialStatement: 'chart', bankStatement: 'bank', taxReturn: 'doc',
  taxForm: 'doc', travel: 'airplane', entityDocument: 'building', email: 'mail', other: 'folder',
};
/** Colours for each part of the chart of accounts. */
const ACCOUNT_SECTION_TINTS = { assets: 'var(--forest)', liabilities: 'var(--leather)', equity: 'var(--gold)', income: 'var(--spruce)', otherIncome: 'var(--spruce)' };
const ACCOUNT_ICONS = {
  bank: 'bank', creditCard: 'card', accountsReceivable: 'inbox', otherAsset: 'box', fixedAsset: 'house', accountsPayable: 'receipt',
  otherLiability: 'doc', loan: 'banknote', equity: 'person', income: 'arrowDown', jobCost: 'hammer', expense: 'arrowUp', otherExpense: 'arrowUp', otherIncome: 'arrowDown',
};
/** A contact's icon: by trade for trades, else by who they are. */
function contactIcon(c) {
  if (c.kind === 'employee') return 'hardhat';
  if (c.kind === 'customer') return 'house';
  if (c.kind === 'lender') return 'bank';
  if (c.kind === 'other') return 'people';
  return tradeIcon(c.trade || '', 'wrench');
}

// ----- Section pages

const SECTION_ICONS = {
  // A project's sections
  overview: 'house', contract: 'signature', budget: 'coins', schedule: 'schedule', money: 'banknote', files: 'folder',
  // Books
  'books:overview': 'grid', transactions: 'list', receipts: 'receipt', waivers: 'seal', accounts: 'bank', reports: 'chart',
  // Trips & Mileage
  list: 'airplane', mileage: 'car', usdays: 'globe', personal: 'wallet',
  // Files
  photos: 'image', documents: 'doc', emails: 'mail',
};

const segIcon = (name) => (name ? icon(name, 'ic seg-ic') : '');
/** The Projects list's groups, as in the Mac's sidebar. */
const GROUP_ICONS = { active: 'hammer', pipeline: 'funnel', rentals: 'key', closed: 'archive' };

/** Weather on a daily log (the Mac's conditions, and the ones the weather service fills in). */
const WEATHER_ICONS = [
  [/thunder|storm/i, 'storm'], [/partly/i, 'cloudSun'], [/rain|drizzle|shower/i, 'rain'], [/snow|freez|ice|sleet/i, 'snow'],
  [/cloud|fog|overcast/i, 'cloud'], [/wind/i, 'wind'], [/hot|heat/i, 'thermo'], [/cold/i, 'thermo'], [/sun|clear/i, 'sun'],
];
const weatherIcon = (text) => iconMatch(text, WEATHER_ICONS, 'cloudSun');
/** A form section's heading with its icon. */
const fsTitle = (name, text) => `<span class="fs-title">${icon(name, 'ic fs-ic')}${text}</span>`;

// ----- What a receipt was for (ReceiptKind)

/** Travel vendors by name, for expenses entered without a kind. */
const EXPENSE_VENDOR_ICONS = [
  [/\b(inn|hotel|suites|marriott|hilton|hyatt|sheraton|westin|airbnb|motel|lodge|resort|hampton)\b/i, 'bed'],
  [/\b(air|airlines?|delta|united|american|westjet|southwest|alaska|porter|flair|frontier|spirit)\b/i, 'airplane'],
  [/\b(enterprise|hertz|avis|national|alamo|sixt|turo|uber|lyft|taxi|cab)\b/i, 'car'],
  [/\b(shell|exxon|chevron|quiktrip|qt|esso|petro|phillips|conoco|valero|casey|fuel|gas)\b/i, 'fuel'],
  [/\b(park|parking|toll|turnpike|pikepass)\b/i, 'parking'],
  [/\b(home depot|lowe|menards|lumber|supply)\b/i, 'box'],
];
const RECEIPT_KIND_ICONS = { meals: 'forkKnife', lodging: 'bed', airfare: 'airplane', carRental: 'car', fuel: 'fuel', parking: 'parking', materials: 'box', office: 'laptop', other: 'dots' };
