/**
 * SandtableTokenOverlay — draggable React tokens layered over the FieldCanvas.
 *
 * Each token represents one of the 6 alliance slots (0-2 red, 3-5 blue).
 * Drag with @dnd-kit; a tap/click without meaningful movement fires
 * `onTokenClick(teamNumber)` because the PointerSensor's activation distance
 * prevents the drag from starting on short clicks.
 *
 * The wrapper has `pointer-events: none` so drawing on the canvas below
 * keeps working between tokens; each token re-enables pointer events on
 * itself.
 */

import { useCallback, useMemo, useState } from "react";
import {
    DndContext,
    PointerSensor,
    TouchSensor,
    useDraggable,
    useSensor,
    useSensors,
    type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement } from "@dnd-kit/modifiers";

interface SandtableTokenOverlayProps {
    selectedTeams: (number | null)[];
    containerWidth: number;
    containerHeight: number;
    onTokenClick?: (teamNumber: number) => void;
}

interface Position {
    x: number;
    y: number;
}

const TOKEN_DIAMETER = 44;

// Default positions are normalized (0..1) so they scale with the canvas.
// Red 0-2 along the right edge, blue 3-5 along the left edge.
const DEFAULT_NORMALIZED_POSITIONS: Position[] = [
    { x: 0.94, y: 0.22 },
    { x: 0.94, y: 0.5 },
    { x: 0.94, y: 0.78 },
    { x: 0.06, y: 0.22 },
    { x: 0.06, y: 0.5 },
    { x: 0.06, y: 0.78 },
];

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

interface TokenProps {
    slotIndex: number;
    teamNumber: number | null;
    pixelPosition: Position;
    isRed: boolean;
    onClick?: () => void;
}

function Token({ slotIndex, teamNumber, pixelPosition, isRed, onClick }: TokenProps) {
    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
        id: `sandtable-token-${slotIndex}`,
        disabled: teamNumber == null,
    });

    const style: React.CSSProperties = {
        position: "absolute",
        left: pixelPosition.x - TOKEN_DIAMETER / 2,
        top: pixelPosition.y - TOKEN_DIAMETER / 2,
        width: TOKEN_DIAMETER,
        height: TOKEN_DIAMETER,
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        zIndex: isDragging ? 20 : 10,
        pointerEvents: "auto",
        touchAction: "none",
        cursor: teamNumber == null ? "default" : isDragging ? "grabbing" : "grab",
    };

    const handleClick = (e: React.MouseEvent) => {
        if (teamNumber == null) return;
        e.stopPropagation();
        onClick?.();
    };

    const colorClasses = isRed
        ? "bg-red-600 text-white border-red-900 ring-red-300"
        : "bg-blue-600 text-white border-blue-900 ring-blue-300";

    return (
        <button
            ref={setNodeRef}
            type="button"
            style={style}
            onClick={handleClick}
            className={`${colorClasses} flex items-center justify-center rounded-full border-2 text-sm font-bold shadow-lg ring-2 ring-offset-1 ring-offset-transparent select-none disabled:opacity-50`}
            aria-label={teamNumber != null ? `Team ${teamNumber}, open stats` : `Empty slot ${slotIndex + 1}`}
            disabled={teamNumber == null}
            {...listeners}
            {...attributes}
        >
            {teamNumber ?? "—"}
        </button>
    );
}

export function SandtableTokenOverlay({
    selectedTeams,
    containerWidth,
    containerHeight,
    onTokenClick,
}: SandtableTokenOverlayProps) {
    const [normalized, setNormalized] = useState<Position[]>(() =>
        DEFAULT_NORMALIZED_POSITIONS.map(p => ({ ...p }))
    );

    // Pointer must move 6px before drag starts; below that a click fires.
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } })
    );

    const handleDragEnd = useCallback(
        (event: DragEndEvent) => {
            const { active, delta } = event;
            const idStr = String(active.id);
            const slotIndex = Number(idStr.replace("sandtable-token-", ""));
            if (Number.isNaN(slotIndex)) return;
            if (containerWidth <= 0 || containerHeight <= 0) return;

            setNormalized(prev => {
                const next = prev.map(p => ({ ...p }));
                const current = next[slotIndex];
                if (!current) return prev;
                const radius = TOKEN_DIAMETER / 2;
                const newX = clamp(current.x * containerWidth + delta.x, radius, containerWidth - radius) / containerWidth;
                const newY = clamp(current.y * containerHeight + delta.y, radius, containerHeight - radius) / containerHeight;
                next[slotIndex] = { x: newX, y: newY };
                return next;
            });
        },
        [containerWidth, containerHeight]
    );

    const pixelPositions = useMemo<Position[]>(
        () =>
            normalized.map(p => ({
                x: p.x * containerWidth,
                y: p.y * containerHeight,
            })),
        [normalized, containerWidth, containerHeight]
    );

    if (containerWidth <= 0 || containerHeight <= 0) return null;

    return (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd} modifiers={[restrictToParentElement]}>
            <div
                style={{
                    position: "absolute",
                    inset: 0,
                    pointerEvents: "none",
                    zIndex: 5,
                }}
            >
                {selectedTeams.slice(0, 6).map((teamNumber, slotIndex) => {
                    const pos = pixelPositions[slotIndex];
                    if (!pos) return null;
                    return (
                        <Token
                            key={slotIndex}
                            slotIndex={slotIndex}
                            teamNumber={teamNumber}
                            pixelPosition={pos}
                            isRed={slotIndex < 3}
                            onClick={teamNumber != null ? () => onTokenClick?.(teamNumber) : undefined}
                        />
                    );
                })}
            </div>
        </DndContext>
    );
}
