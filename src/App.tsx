import { useState, type ComponentType } from "react";
import { Upload, LayoutGrid, Pencil, Settings } from "lucide-react";
import MockupListsPage from "./components/MockupListsPage";
import UploadPage from "./components/UploadPage";
import BulkEditorPage from "./components/BulkEditorPage";

type Tab = "upload" | "mockups" | "editor" | "settings";

const NAV: { id: Tab; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { id: "upload", label: "Bulk Upload", icon: Upload },
  { id: "mockups", label: "Mockup-Listen", icon: LayoutGrid },
  { id: "editor", label: "Shopify Editor", icon: Pencil },
  { id: "settings", label: "Einstellungen", icon: Settings },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("upload");

  return (
    <div className="flex flex-col lg:flex-row min-h-screen bg-slate-50 font-sans">
      <aside className="w-full lg:w-72 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 flex flex-col p-7 shrink-0">
        <div className="flex items-center gap-3.5 mb-12">
          <div className="w-10 h-10 bg-slate-900 grid place-items-center shrink-0">
            <span className="font-display text-white text-lg leading-none tracking-wide">AF</span>
          </div>
          <div className="min-w-0">
            <h2 className="font-display text-slate-900 text-xl leading-tight tracking-wide">Atelier Faille</h2>
            <span className="eyebrow">Upload Programm</span>
          </div>
        </div>

        <div className="eyebrow mb-3 px-1">Werkstatt</div>
        <nav className="space-y-1">
          {NAV.map(({ id, label, icon: Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`w-full px-4 py-2.5 rounded-lg text-[13px] flex items-center gap-3 text-left cursor-pointer transition-colors ${
                  active
                    ? "bg-slate-900 text-white font-medium"
                    : "text-slate-500 hover:text-slate-900 hover:bg-slate-100 font-normal"
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="mt-auto pt-8 hidden lg:block">
          <div className="border-t border-slate-200 pt-4">
            <p className="eyebrow leading-relaxed">Midjourney → Photopea<br />→ Printify → Shopify</p>
          </div>
        </div>
      </aside>

      <main className="flex-1 min-w-0 p-6 md:p-10 lg:p-12 overflow-y-auto">
        <div hidden={tab !== "upload"}><UploadPage /></div>
        <div hidden={tab !== "mockups"}><MockupListsPage /></div>
        <div hidden={tab !== "editor"}><BulkEditorPage /></div>
        <div hidden={tab !== "settings"}>
          <Placeholder title="Einstellungen" hint="API-Verbindungen, Preise, Defaults." />
        </div>
      </main>
    </div>
  );
}

function Placeholder({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="max-w-2xl">
      <div className="eyebrow mb-2">Atelier Faille</div>
      <h1 className="page-h1 mb-3">{title}</h1>
      <p className="text-sm text-slate-500">{hint}</p>
    </div>
  );
}
