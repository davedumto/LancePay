"use client";

import { useEffect } from "react";
import { logError } from "@/lib/logger";
import { AlertCircle, RefreshCcw, Home } from "lucide-react";
import { motion } from "framer-motion";
import Link from "next/link";

export default function Error({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        logError(error, { digest: error.digest });
    }, [error]);

    return (
        <div className="min-h-screen flex items-center justify-center bg-brand-light p-4 font-sans">
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="max-w-md w-full bg-white rounded-2xl shadow-xl shadow-black/5 border border-brand-border p-8 text-center"
            >
                <div className="mb-6 flex justify-center">
                    <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center">
                        <AlertCircle className="w-8 h-8 text-red-500" />
                    </div>
                </div>

                <h1 className="text-2xl font-display font-bold text-brand-black mb-2 tracking-tightest">
                    Something went wrong
                </h1>

                <p className="text-brand-gray mb-8 leading-relaxed">
                    An unexpected error occurred. Our team has been notified. Please try refreshing the page or head back home.
                </p>

                <div className="flex flex-col gap-3">
                    <button
                        onClick={() => reset()}
                        className="w-full flex items-center justify-center gap-2 bg-brand-black text-white py-3 px-6 rounded-xl font-medium hover:bg-black transition-colors active:scale-[0.98]"
                    >
                        <RefreshCcw className="w-4 h-4" />
                        Try again
                    </button>

                    <Link
                        href="/"
                        className="w-full flex items-center justify-center gap-2 bg-white text-brand-black border border-brand-border py-3 px-6 rounded-xl font-medium hover:bg-brand-light transition-colors active:scale-[0.98]"
                    >
                        <Home className="w-4 h-4" />
                        Return Home
                    </Link>
                </div>

                {error.digest && (
                    <p className="mt-8 text-xs text-brand-muted font-mono">
                        Error ID: {error.digest}
                    </p>
                )}
            </motion.div>
        </div>
    );
}
