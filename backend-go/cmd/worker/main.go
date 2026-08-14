// BAGALEWATCH BTS v2 — Go worker service.
//
// Owns the performance-critical processing tier: the TRP (.trp) binary
// decoder port (Phase 5 — the highest-risk single item in the migration
// plan, see docs/RUNBOOK.md), bulk XLSX/CSV export generation for large
// drive-test batches, and RSRP/RSRQ/SINR band computation over large
// sample sets. Reached via a Redis job queue from Django, never called
// directly by the browser (see docs/RUNBOOK.md "Service contracts").
//
// This service never touches the v1 system's files — it is a completely
// separate, standalone binary with its own dependencies.
//
// Phase 0 scope: an HTTP health check only. Job-queue consumption
// (Redis), TRP parsing, and export generation are Phase 4/5 work — they
// depend on the Postgres schema and job contract that don't exist yet
// until those phases land.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

type healthResponse struct {
	Service string `json:"service"`
	Status  string `json:"status"`
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	resp := healthResponse{
		Service: "bagalewatch-v2-go-worker",
		Status:  "ok",
	}
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("health handler encode error: %v", err)
	}
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8070"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)

	addr := ":" + port
	log.Printf("[bagalewatch-v2-go-worker] listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("server failed: %v", err)
	}
}
