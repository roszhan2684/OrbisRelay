import type { Metadata } from "next";
import { VerifyTool } from "./verify-tool";
import { Nav } from "@/components/marketing/parts";

export const metadata: Metadata = { title: "Verify a receipt", description: "Independently verify an Orbis Relay decision receipt in your browser." };

export default function VerifyPage() {
  return (
    <div className="min-h-screen bg-page">
      <div className="bg-night pb-16 pt-32 text-white">
        <Nav />
        <div className="mx-auto max-w-[900px] px-5">
          <div className="text-[12.5px] font-semibold uppercase tracking-[0.14em] text-[#8fa2ff]">Receipt verifier</div>
          <h1 className="mt-3 text-[40px] font-semibold leading-[1.05] tracking-[-0.035em]">Don't trust us. Verify.</h1>
          <p className="mt-4 max-w-[620px] text-[16px] leading-relaxed text-white/60">Paste an exported Orbis decision receipt. Your browser re-canonicalizes the body, recomputes the SHA-256 hash and checks the Ed25519 signature against Orbis's published key — nothing leaves your machine except a public-key fetch.</p>
        </div>
      </div>
      <div className="mx-auto max-w-[900px] px-5 py-10">
        <VerifyTool />
      </div>
    </div>
  );
}
