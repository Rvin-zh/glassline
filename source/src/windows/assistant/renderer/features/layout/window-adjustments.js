export function createWindowAdjustmentManager({
    windowResizeHandles,
    windowDragHandle,
    chatContainer,
    minWindowWidth,
    minWindowHeight,
    onViewportResize
}) {
    let activeWindowResize = null;
    let activeWindowDrag = null;
    let pendingWindowBounds = null;
    let windowResizeFrame = null;

    function setupWindowAdjustments() {
        setupWindowResizeHandles();
        enforceChatFillLayout();
        window.addEventListener('resize', () => {
            enforceChatFillLayout();
            onViewportResize?.();
        });
    }

    function enforceChatFillLayout() {
        if (!chatContainer) {
            return;
        }

        // Ensure stale manual-resize inline styles never pin chat height.
        chatContainer.style.removeProperty('height');
    }

    function setupWindowResizeHandles() {
        if (!window.electronAPI || !windowResizeHandles.length) {
            return;
        }

        windowResizeHandles.forEach((handle) => {
            handle.addEventListener('pointerdown', startWindowResize);
        });

        if (windowDragHandle) {
            windowDragHandle.addEventListener('pointerdown', startWindowDrag);
        }
    }

    async function startWindowDrag(event) {
        if (event.button !== 0 || activeWindowResize || activeWindowDrag) {
            return;
        }

        if (event.target?.closest?.('button, a, input, select, textarea')) {
            return;
        }

        if (!window.electronAPI?.getWindowBounds || !window.electronAPI?.setWindowBounds) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const pointerId = event.pointerId;
        let released = false;
        const noteRelease = (releaseEvent) => {
            if (releaseEvent.pointerId === pointerId) {
                released = true;
            }
        };
        document.addEventListener('pointerup', noteRelease);
        document.addEventListener('pointercancel', noteRelease);

        const startBounds = await window.electronAPI.getWindowBounds();
        document.removeEventListener('pointerup', noteRelease);
        document.removeEventListener('pointercancel', noteRelease);
        if (released || activeWindowResize || activeWindowDrag) {
            return;
        }
        if (!startBounds || startBounds.error) {
            console.error('Failed to get initial window bounds:', startBounds?.error);
            return;
        }

        activeWindowDrag = {
            pointerId: event.pointerId,
            startScreenX: event.screenX,
            startScreenY: event.screenY,
            startBounds
        };

        document.body.classList.add('window-dragging');
        windowDragHandle.setPointerCapture?.(event.pointerId);
        document.addEventListener('pointermove', onWindowDragMove);
        document.addEventListener('pointerup', stopWindowDrag);
        document.addEventListener('pointercancel', stopWindowDrag);
    }

    function onWindowDragMove(event) {
        if (!activeWindowDrag || event.pointerId !== activeWindowDrag.pointerId) {
            return;
        }

        event.preventDefault();
        scheduleWindowResize({
            x: activeWindowDrag.startBounds.x + (event.screenX - activeWindowDrag.startScreenX),
            y: activeWindowDrag.startBounds.y + (event.screenY - activeWindowDrag.startScreenY),
            width: activeWindowDrag.startBounds.width,
            height: activeWindowDrag.startBounds.height
        });
    }

    function stopWindowDrag(event) {
        if (!activeWindowDrag) {
            return;
        }

        if (event.pointerId && event.pointerId !== activeWindowDrag.pointerId) {
            return;
        }

        windowDragHandle?.releasePointerCapture?.(activeWindowDrag.pointerId);
        activeWindowDrag = null;
        pendingWindowBounds = null;

        if (windowResizeFrame) {
            window.cancelAnimationFrame(windowResizeFrame);
            windowResizeFrame = null;
        }

        document.body.classList.remove('window-dragging');
        document.removeEventListener('pointermove', onWindowDragMove);
        document.removeEventListener('pointerup', stopWindowDrag);
        document.removeEventListener('pointercancel', stopWindowDrag);
    }

    async function startWindowResize(event) {
        if (activeWindowDrag || activeWindowResize) {
            return;
        }

        if (!window.electronAPI?.getWindowBounds || !window.electronAPI?.setWindowBounds) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const handleElement = event.currentTarget;
        if (!handleElement) {
            return;
        }

        const direction = handleElement.dataset.resizeHandle;
        const pointerId = event.pointerId;
        const startScreenX = event.screenX;
        const startScreenY = event.screenY;
        const startBounds = await window.electronAPI.getWindowBounds();
        if (!startBounds || startBounds.error) {
            console.error('Failed to get initial window bounds:', startBounds?.error);
            return;
        }

        activeWindowResize = {
            direction,
            pointerId,
            startScreenX,
            startScreenY,
            startBounds,
            handleElement
        };

        document.body.classList.add('window-resizing');
        handleElement.setPointerCapture?.(pointerId);

        document.addEventListener('pointermove', onWindowResizeMove);
        document.addEventListener('pointerup', stopWindowResize);
        document.addEventListener('pointercancel', stopWindowResize);
    }

    function onWindowResizeMove(event) {
        if (!activeWindowResize || event.pointerId !== activeWindowResize.pointerId) {
            return;
        }

        event.preventDefault();

        const deltaX = event.screenX - activeWindowResize.startScreenX;
        const deltaY = event.screenY - activeWindowResize.startScreenY;
        const nextBounds = calculateWindowResizeBounds(
            activeWindowResize.startBounds,
            activeWindowResize.direction,
            deltaX,
            deltaY
        );

        scheduleWindowResize(nextBounds);
    }

    function calculateWindowResizeBounds(startBounds, direction, deltaX, deltaY) {
        let { x, y, width, height } = startBounds;

        if (direction.includes('e')) {
            width = Math.max(minWindowWidth, startBounds.width + deltaX);
        }

        if (direction.includes('s')) {
            height = Math.max(minWindowHeight, startBounds.height + deltaY);
        }

        if (direction.includes('w')) {
            const nextWidth = Math.max(minWindowWidth, startBounds.width - deltaX);
            x = startBounds.x + (startBounds.width - nextWidth);
            width = nextWidth;
        }

        if (direction.includes('n')) {
            const nextHeight = Math.max(minWindowHeight, startBounds.height - deltaY);
            y = startBounds.y + (startBounds.height - nextHeight);
            height = nextHeight;
        }

        return {
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(width),
            height: Math.round(height)
        };
    }

    function scheduleWindowResize(bounds) {
        pendingWindowBounds = bounds;
        if (windowResizeFrame) {
            return;
        }

        windowResizeFrame = window.requestAnimationFrame(async () => {
            windowResizeFrame = null;
            const nextBounds = pendingWindowBounds;
            pendingWindowBounds = null;

            if (!nextBounds) {
                return;
            }

            const result = await window.electronAPI.setWindowBounds(nextBounds);
            if (result && result.error) {
                console.error('Failed to set window bounds:', result.error);
            }
        });
    }

    function stopWindowResize(event) {
        if (!activeWindowResize) {
            return;
        }

        if (event.pointerId && event.pointerId !== activeWindowResize.pointerId) {
            return;
        }

        activeWindowResize.handleElement?.releasePointerCapture?.(activeWindowResize.pointerId);
        activeWindowResize = null;
        pendingWindowBounds = null;

        if (windowResizeFrame) {
            window.cancelAnimationFrame(windowResizeFrame);
            windowResizeFrame = null;
        }

        document.body.classList.remove('window-resizing');
        document.removeEventListener('pointermove', onWindowResizeMove);
        document.removeEventListener('pointerup', stopWindowResize);
        document.removeEventListener('pointercancel', stopWindowResize);
    }

    return {
        setupWindowAdjustments
    };
}
