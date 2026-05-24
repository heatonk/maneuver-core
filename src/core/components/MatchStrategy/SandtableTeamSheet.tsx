/**
 * SandtableTeamSheet — side sheet showing a team's auto preferences and
 * scoring contribution when a Sandtable robot token is tapped.
 *
 * Reuses the existing AutoAnalysis composite (start position map + breakdown
 * + paths-by-position replay) so nothing new is derived here; we just frame
 * it with a short summary header.
 */

import { useMemo } from "react";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@/core/components/ui/sheet";
import { Badge } from "@/core/components/ui/badge";
import { Card, CardContent } from "@/core/components/ui/card";
import { strategyAnalysis } from "@/game-template/analysis";
import { AutoAnalysis } from "@/game-template/components/team-stats/AutoAnalysis";
import type { TeamStats } from "@/core/types/team-stats";

interface SandtableTeamSheetProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    teamNumber: number | null;
    alliance: "red" | "blue" | null;
    teamStats: TeamStats | null;
}

function fmt(value: number | undefined | null): string {
    if (value == null || Number.isNaN(value)) return "—";
    return (Math.round(value * 10) / 10).toString();
}

export function SandtableTeamSheet({
    open,
    onOpenChange,
    teamNumber,
    alliance,
    teamStats,
}: SandtableTeamSheetProps) {
    const startPositionConfig = useMemo(() => strategyAnalysis.getStartPositionConfig(), []);

    const allianceLabel = alliance === "red" ? "Red Alliance" : alliance === "blue" ? "Blue Alliance" : "—";
    const allianceBadgeClass =
        alliance === "red"
            ? "bg-red-600 text-white hover:bg-red-600"
            : alliance === "blue"
            ? "bg-blue-600 text-white hover:bg-blue-600"
            : "";

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
                <SheetHeader>
                    <div className="flex items-center gap-3">
                        <SheetTitle>{teamNumber != null ? `Team ${teamNumber}` : "Team"}</SheetTitle>
                        {alliance && <Badge className={allianceBadgeClass}>{allianceLabel}</Badge>}
                    </div>
                    <SheetDescription>
                        {teamStats
                            ? `Based on ${teamStats.matchCount} scouted match${teamStats.matchCount === 1 ? "" : "es"}.`
                            : "No scouting data available for this team yet."}
                    </SheetDescription>
                </SheetHeader>

                <div className="space-y-6 px-4 pb-6">
                    {teamStats && teamStats.matchCount > 0 ? (
                        <>
                            <div className="grid grid-cols-4 gap-2">
                                <SummaryStat label="Total" value={fmt(teamStats.overall?.avgTotalPoints)} accent="default" />
                                <SummaryStat label="Auto" value={fmt(teamStats.auto?.avgPoints)} accent="emerald" />
                                <SummaryStat label="Teleop" value={fmt(teamStats.teleop?.avgPoints)} accent="sky" />
                                <SummaryStat label="Endgame" value={fmt(teamStats.endgame?.avgPoints)} accent="violet" />
                            </div>

                            <AutoAnalysis
                                teamStats={teamStats}
                                compareStats={null}
                                startPositionConfig={startPositionConfig}
                                showStartPositionMap={false}
                            />
                        </>
                    ) : (
                        <Card>
                            <CardContent className="flex flex-col items-center justify-center py-12">
                                <p className="text-muted-foreground text-sm">
                                    No scouted matches for {teamNumber != null ? `team ${teamNumber}` : "this team"} yet.
                                </p>
                            </CardContent>
                        </Card>
                    )}
                </div>
            </SheetContent>
        </Sheet>
    );
}

interface SummaryStatProps {
    label: string;
    value: string;
    accent: "default" | "emerald" | "sky" | "violet";
}

function SummaryStat({ label, value, accent }: SummaryStatProps) {
    const accentClass = {
        default: "text-foreground",
        emerald: "text-emerald-600 dark:text-emerald-400",
        sky: "text-sky-600 dark:text-sky-400",
        violet: "text-violet-600 dark:text-violet-400",
    }[accent];

    return (
        <Card>
            <CardContent className="flex flex-col items-center gap-1 p-3">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
                <span className={`text-xl font-bold tabular-nums ${accentClass}`}>{value}</span>
                <span className="text-[10px] text-muted-foreground">avg pts</span>
            </CardContent>
        </Card>
    );
}
