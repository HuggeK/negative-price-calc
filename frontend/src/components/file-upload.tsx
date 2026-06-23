"use client";

import { useCallback, useState } from "react";
import { Card, CardContent } from "@sourceful-energy/ui";
import { Upload, FileSpreadsheet, X } from "lucide-react";

interface FileUploadProps {
  onFilesSelect: (files: File[]) => void;
  selectedFiles: File[];
}

function isValidFile(file: File): boolean {
  const validTypes = [
    "text/csv",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ];
  const validExtensions = [".csv", ".xlsx", ".xls"];
  const extension = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
  return validTypes.includes(file.type) || validExtensions.includes(extension);
}

/** Append valid files, skipping ones already chosen (by name + size). */
function mergeFiles(existing: File[], incoming: File[]): File[] {
  const valid = incoming.filter(isValidFile);
  const seen = new Set(existing.map((f) => `${f.name}:${f.size}`));
  const merged = [...existing];
  for (const f of valid) {
    const key = `${f.name}:${f.size}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(f);
    }
  }
  return merged;
}

export function FileUpload({ onFilesSelect, selectedFiles }: FileUploadProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      onFilesSelect(mergeFiles(selectedFiles, Array.from(e.dataTransfer.files)));
    },
    [onFilesSelect, selectedFiles]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onFilesSelect(mergeFiles(selectedFiles, Array.from(e.target.files ?? [])));
      e.target.value = ""; // allow re-selecting the same file after removal
    },
    [onFilesSelect, selectedFiles]
  );

  const removeFile = useCallback(
    (index: number) => {
      onFilesSelect(selectedFiles.filter((_, i) => i !== index));
    },
    [onFilesSelect, selectedFiles]
  );

  const hasFiles = selectedFiles.length > 0;

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-foreground">
        Elproduktions-/exportdata (CSV eller Excel)
      </label>
      <Card
        className={`border-2 border-dashed transition-colors ${
          isDragOver
            ? "border-primary bg-primary/5"
            : hasFiles
            ? "border-primary/50 bg-primary/5"
            : "border-muted-foreground/25 hover:border-muted-foreground/50"
        }`}
      >
        <CardContent className="p-6">
          {hasFiles ? (
            <div className="space-y-3">
              {selectedFiles.map((file, i) => (
                <div key={`${file.name}:${file.size}`} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <FileSpreadsheet className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">{file.name}</p>
                      <p className="text-sm text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</p>
                    </div>
                  </div>
                  <button
                    onClick={() => removeFile(i)}
                    className="p-1 rounded-full hover:bg-muted transition-colors"
                    aria-label={`Ta bort ${file.name}`}
                  >
                    <X className="h-5 w-5 text-muted-foreground" />
                  </button>
                </div>
              ))}
              <label
                className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-muted-foreground/30 py-2 text-sm text-muted-foreground hover:border-muted-foreground/60"
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <Upload className="h-4 w-4" />
                Lägg till fler filer (t.ex. fler 3-månaderschunkar)
                <input type="file" accept=".csv,.xlsx,.xls" multiple onChange={handleFileInput} className="hidden" />
              </label>
            </div>
          ) : (
            <label
              className="flex flex-col items-center gap-3 cursor-pointer"
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div className="p-3 rounded-full bg-muted">
                <Upload className="h-6 w-6 text-muted-foreground" />
              </div>
              <div className="text-center">
                <p className="font-medium text-foreground">Klicka för att välja dina filer från nätbolaget</p>
                <p className="text-sm text-muted-foreground">
                  Eller dra och släpp CSV/Excel här. Du kan välja flera filer – nätbolag delar ofta upp 15-minutersdata i
                  3-månaderschunkar.
                </p>
              </div>
              <input type="file" accept=".csv,.xlsx,.xls" multiple onChange={handleFileInput} className="hidden" />
            </label>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
