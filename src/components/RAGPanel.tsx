"use client";

import React, { useState, useEffect } from "react";
import {
  BookOpen,
  Send,
  Loader2,
  FileText,
  Sparkles,
  Search,
  Quote,
  AlertCircle,
  FileCode,
  Layers,
  RotateCw,
} from "lucide-react";
import type { RAGDocument, RAGAnswer } from "../types/rag";

interface RAGPanelProps {
  activeProjectId: string;
  onOpenUpload: () => void;
}

export function RAGPanel({ activeProjectId, onOpenUpload }: RAGPanelProps) {
  const [documents, setDocuments] = useState<RAGDocument[]>([]);
  const [totalChunks, setTotalChunks] = useState(0);
  const [isLoadingDocs, setIsLoadingDocs] = useState(false);
  const [question, setQuestion] = useState("");
  const [topK, setTopK] = useState(5);
  const [isAsking, setIsAsking] = useState(false);
  const [ragAnswer, setRagAnswer] = useState<RAGAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchDocuments = async () => {
    setIsLoadingDocs(true);
    try {
      const res = await fetch(`/api/rag/documents?projectId=${activeProjectId}`);
      if (res.ok) {
        const data = await res.json();
        setDocuments(data.documents || []);
        setTotalChunks(data.totalChunks || 0);
      }
    } catch {
      // Ignore
    } finally {
      setIsLoadingDocs(false);
    }
  };

  useEffect(() => {
    let isMounted = true;
    fetch(`/api/rag/documents?projectId=${activeProjectId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!isMounted || !data) return;
        setDocuments(data.documents || []);
        setTotalChunks(data.totalChunks || 0);
      })
      .catch(() => {})
      .finally(() => {
        if (isMounted) setIsLoadingDocs(false);
      });

    return () => {
      isMounted = false;
    };
  }, [activeProjectId]);

  const handleAsk = async (promptToAsk?: string) => {
    const q = (promptToAsk || question).trim();
    if (!q) return;

    setIsAsking(true);
    setError(null);
    setRagAnswer(null);

    try {
      const res = await fetch("/api/rag/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: activeProjectId,
          question: q,
          topK,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to query RAG knowledge base");
      }

      setRagAnswer(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error querying knowledge base");
    } finally {
      setIsAsking(false);
    }
  };

  const sampleQuestions = [
    "Why does this project fail when I upload a file?",
    "What permitted tools are defined in the workflow?",
    "What memory limit is specified in runtime configuration?",
    "How does the recovery engine safeguard against path traversal?",
  ];

  return (
    <div className="space-y-6">
      {/* Overview Banner */}
      <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/90 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-cyan-400" />
            <h2 className="text-base font-semibold text-slate-100">
              Project RAG Knowledge Base
            </h2>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
              Cosine Similarity Vector Index
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Grounded question-answering with citation extraction over workspace code, Markdown, and uploaded PDFs.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-xs font-mono text-slate-400">
            <span className="text-cyan-400 font-semibold">{documents.length}</span> doc(s) /{" "}
            <span className="text-teal-400 font-semibold">{totalChunks}</span> vector chunks
          </div>
          <button
            onClick={() => fetchDocuments()}
            disabled={isLoadingDocs}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs transition disabled:opacity-50"
            title="Refresh Knowledge Documents"
          >
            <RotateCw className={`w-3.5 h-3.5 ${isLoadingDocs ? "animate-spin text-cyan-400" : ""}`} />
          </button>
          <button
            onClick={onOpenUpload}
            className="px-3 py-1.5 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 text-xs font-semibold transition"
          >
            Upload Documents
          </button>
        </div>
      </div>

      {/* Query & Ask Section */}
      <div className="p-5 rounded-xl border border-slate-800 bg-slate-900/60 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
            <Search className="w-3.5 h-3.5 text-cyan-400" />
            Ask Project Documents
          </h3>

          <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
            <span>Top-K Chunks:</span>
            <select
              value={topK}
              onChange={(e) => setTopK(parseInt(e.target.value, 10))}
              className="bg-slate-950 border border-slate-700 rounded px-2 py-0.5 text-slate-200"
            >
              <option value="3">3</option>
              <option value="5">5</option>
              <option value="8">8</option>
            </select>
          </div>
        </div>

        {/* Input box */}
        <div className="relative">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask a technical question about your project workspace, policies, or code..."
            rows={3}
            className="w-full p-3 pr-24 rounded-xl bg-slate-950/80 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-cyan-500 resize-none font-sans"
          />
          <button
            onClick={() => handleAsk()}
            disabled={isAsking || !question.trim()}
            className="absolute right-3 bottom-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-400 hover:to-teal-400 text-slate-950 text-xs font-bold transition disabled:opacity-40"
          >
            {isAsking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            Ask AI
          </button>
        </div>

        {/* Quick sample prompts */}
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-[11px] text-slate-400">Quick queries:</span>
          {sampleQuestions.map((q, i) => (
            <button
              key={i}
              onClick={() => {
                setQuestion(q);
                handleAsk(q);
              }}
              className="px-2 py-1 rounded bg-slate-800/80 hover:bg-slate-800 text-slate-300 text-[11px] border border-slate-700/60 transition"
            >
              {q}
            </button>
          ))}
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-center gap-2 text-xs text-rose-300">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Answer Display */}
        {ragAnswer && (
          <div className="mt-4 p-4 rounded-xl bg-slate-950/90 border border-cyan-500/30 space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-semibold text-cyan-300">Synthesized Grounded Answer</span>
                {ragAnswer.grounded ? (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    Citations Verified ({ragAnswer.retrievedCount} chunks)
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    Low Evidence
                  </span>
                )}
              </div>
              <span className="text-[10px] text-slate-400 font-mono">
                Model: {ragAnswer.model}
              </span>
            </div>

            <div className="text-xs text-slate-200 leading-relaxed whitespace-pre-wrap font-sans">
              {ragAnswer.answer}
            </div>

            {/* Citations & Evidence Chunks */}
            {ragAnswer.citations.length > 0 && (
              <div className="pt-3 border-t border-slate-800 space-y-2">
                <h4 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Quote className="w-3 h-3 text-cyan-400" />
                  Retrieved Evidence Sources
                </h4>

                <div className="space-y-1.5">
                  {ragAnswer.citations.map((cite, idx) => (
                    <div
                      key={idx}
                      className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-cyan-500/20 text-cyan-300">
                            {cite.sourceId}
                          </span>
                          <span className="font-mono text-slate-300 font-medium">{cite.fileName}</span>
                          {cite.pageNumber && (
                            <span className="text-[10px] text-slate-400">
                              (Page {cite.pageNumber})
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] font-mono text-emerald-400">
                          Relevance: {Math.round(cite.similarityScore * 100)}%
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 font-mono italic pl-2 border-l border-slate-700">
                        &quot;{cite.relevantExcerpt}&quot;
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Indexed Documents Table */}
      <div className="p-5 rounded-xl border border-slate-800 bg-slate-900/60 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
          <Layers className="w-3.5 h-3.5 text-teal-400" />
          Indexed Knowledge Documents
        </h3>

        {documents.length === 0 ? (
          <div className="p-8 text-center rounded-lg bg-slate-950/40 border border-slate-800">
            <FileText className="w-8 h-8 mx-auto text-slate-600 mb-2" />
            <p className="text-xs text-slate-400 font-medium">No documents indexed in this project yet.</p>
            <p className="text-[11px] text-slate-400 mt-1">
              Upload source files or PDF documentation to enable semantic retrieval.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 uppercase text-[10px]">
                  <th className="py-2 px-3">File Name</th>
                  <th className="py-2 px-3">Type</th>
                  <th className="py-2 px-3">Chunks</th>
                  <th className="py-2 px-3">Size</th>
                  <th className="py-2 px-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-300">
                {documents.map((doc) => (
                  <tr key={doc.id} className="hover:bg-slate-950/40">
                    <td className="py-2 px-3 flex items-center gap-2">
                      {doc.fileName.endsWith(".pdf") ? (
                        <FileText className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                      ) : (
                        <FileCode className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      )}
                      <span className="truncate">{doc.fileName}</span>
                    </td>
                    <td className="py-2 px-3 text-slate-400">{doc.mimeType}</td>
                    <td className="py-2 px-3 text-cyan-400">{doc.chunkCount}</td>
                    <td className="py-2 px-3 text-slate-400">{(doc.sizeBytes / 1024).toFixed(1)} KB</td>
                    <td className="py-2 px-3">
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        {doc.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
