import './styles.css';

const panesEl = document.getElementById('panes') as HTMLDivElement;
const addPaneBtn = document.getElementById('add-pane') as HTMLButtonElement;

// Wired up in later phases: panes are created once the shared
// `code serve-web` server is ready.
void panesEl;
void addPaneBtn;
