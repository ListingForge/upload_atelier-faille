import { useState, type ComponentType } from "react";
import { Upload, LayoutGrid, Pencil, Settings, Flame } from "lucide-react";
import MockupListsPage from "./components/MockupListsPage";
import UploadPage from "./components/UploadPage";
import EditorPage from "./components/EditorPage";

type Tab = "upload" | "mockups" | "editor" | "settings";

const NAV: { id: Tab; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { id: "upload", label: "Bulk Upload", icon: Upload },
  { id: "mockups", label: "Mockup-Listen", icon: LayoutGrid },
  { id: "editor", label: "Shopify Editor", icon: Pencil },
  { id: "settings", label: "Einstellungen", icon: Settings },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("mockups");

  return (
    <div className="flex flex-col lg:flex-row min-h-screen bg-slate-50 font-sans">
      <aside className="w-full lg:w-64 bg-slate-900 border-r border-slate-800 text-slate-300 flex flex-col p-6 shrink-0">
        <div className="flex items-center gap-3 mb-10">
          <div className="w-9 h-9 rounded-xl bg-indigo-600 grid place-items-center">
            <Flame className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="font-black text-white text-sm tracking-widest uppercase">Atelier Faille</h2>
            <span className="text-[10px] text-zinc-500 font-mono">Upload Programm</span>
          </div>
        </div>

        <nav className="space-y-1.5">
          {NAV.map(({ id, label, icon: Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`w-full px-4 py-3 rounded-xl text-xs font-semibold flex items-center gap-3 text-left cursor-pointer transition-colors ${
                  active ? "bg-indigo-600 text-white" : "hover:bg-slate-800 text-slate-400 hover:text-white"
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="flex-1 min-w-0 p-6 md:p-10 overflow-y-auto">
        {tab === "upload" && <UploadPage />}
        {tab === "mockups" && <MockupListsPage />}
        {tab === "editor" && <EditorPage />}
        {tab === "settings" && <Placeholder title="Einstellungen" hint="API-Verbindungen, Preise, Defaults." />}
      </main>
    </div>
  );
}

function Placeholder({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-slate-900 mb-2">{title}</h1>
      <p className="text-sm text-slate-500">{hint}</p>
    </div>
  );
}
