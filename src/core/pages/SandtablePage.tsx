/**
 * Sandtable — per-match strategy planning surface.
 *
 * Field drawing across Auto / Teleop / Endgame, alliance selection, and
 * per-team scouting stats on one screen. Year-agnostic via centralized
 * `useAllTeamStats`, configurable field image, and config-driven stat
 * display in `match-strategy-config.ts`.
 */

import { useCallback, useState } from "react";
import { MatchHeader } from "@/core/components/MatchStrategy/MatchHeader";
import { FieldStrategy } from "@/core/components/MatchStrategy/FieldStrategy";
import { TeamAnalysis } from "@/core/components/MatchStrategy/TeamAnalysis";
import { SandtableTeamSheet } from "@/core/components/MatchStrategy/SandtableTeamSheet";
import { clearAllStrategies, saveAllStrategyCanvases } from "@/core/lib/strategyCanvasUtils";
import { useMatchStrategy } from "@/core/hooks/useMatchStrategy";
import fieldImage from "@/game-template/assets/FieldImage2026.svg";

const SandtablePage = () => {
    const [activeTab, setActiveTab] = useState("autonomous");
    const [activeStatsTab, setActiveStatsTab] = useState("overall");
    const [sheetTeam, setSheetTeam] = useState<number | null>(null);

    const {
        selectedTeams,
        availableTeams,
        availableEvents,
        selectedEvent,
        matchNumber,
        isLookingUpMatch,
        confirmedAlliances,
        selectedBlueAlliance,
        selectedRedAlliance,
        getTeamStats,
        handleTeamChange,
        applyAllianceToRed,
        applyAllianceToBlue,
        setSelectedEvent,
        setMatchNumber
    } = useMatchStrategy();

    const handleClearAll = () => clearAllStrategies(setActiveTab, activeTab);
    const handleSaveAll = () => saveAllStrategyCanvases(matchNumber, selectedTeams, fieldImage);

    const handleTokenClick = useCallback((teamNumber: number) => {
        setSheetTeam(teamNumber);
    }, []);

    const sheetTeamSlotIndex = sheetTeam != null
        ? selectedTeams.findIndex(t => t === sheetTeam)
        : -1;
    const sheetTeamAlliance: "red" | "blue" | null =
        sheetTeamSlotIndex === -1 ? null : sheetTeamSlotIndex < 3 ? "red" : "blue";
    const sheetTeamStats = sheetTeam != null ? getTeamStats(sheetTeam) : null;

    return (
        <div className="min-h-screen w-full flex flex-col items-center px-4 pt-12 pb-24">
            <div className="w-full max-w-7xl">
                <h1 className="text-2xl font-bold">Sandtable</h1>
            </div>
            <div className="flex flex-col items-center gap-4 max-w-7xl w-full">
                <MatchHeader
                    selectedEvent={selectedEvent}
                    availableEvents={availableEvents}
                    matchNumber={matchNumber}
                    isLookingUpMatch={isLookingUpMatch}
                    onEventChange={setSelectedEvent}
                    onMatchNumberChange={setMatchNumber}
                    onClearAll={handleClearAll}
                    onSaveAll={handleSaveAll}
                />

                <div className="flex flex-col gap-8 w-full pb-6">
                    <FieldStrategy
                        fieldImagePath={fieldImage}
                        activeTab={activeTab}
                        selectedTeams={selectedTeams}
                        onTabChange={setActiveTab}
                        onTokenClick={handleTokenClick}
                    />

                    <TeamAnalysis
                        selectedTeams={selectedTeams}
                        availableTeams={availableTeams}
                        activeStatsTab={activeStatsTab}
                        confirmedAlliances={confirmedAlliances}
                        selectedBlueAlliance={selectedBlueAlliance}
                        selectedRedAlliance={selectedRedAlliance}
                        getTeamStats={getTeamStats}
                        onTeamChange={handleTeamChange}
                        onStatsTabChange={setActiveStatsTab}
                        onBlueAllianceChange={applyAllianceToBlue}
                        onRedAllianceChange={applyAllianceToRed}
                    />
                </div>
            </div>

            <SandtableTeamSheet
                open={sheetTeam != null}
                onOpenChange={(next) => { if (!next) setSheetTeam(null); }}
                teamNumber={sheetTeam}
                alliance={sheetTeamAlliance}
                teamStats={sheetTeamStats}
            />
        </div>
    );
};

export default SandtablePage;
