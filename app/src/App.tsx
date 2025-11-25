// app/src/App.tsx
import { useMemo, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
} from "reactflow";
import type { Node, Edge } from "reactflow";
import "reactflow/dist/style.css";

import wbs from "./wbs_satellite_example.json";

// ノード型（必要に応じて拡張していく）
type WbsNode = Node & {
  wbs_code?: string;
};

// エッジ型（WBS独自の情報を data に載せる）
type WbsEdge = Edge & {
  data?: {
    wbsType?: string; // HIERARCHY / DOC_DEPENDS_ON など
    based_on_version?: string;
    approved?: boolean;
    [key: string]: any;
  };
};

type ViewMode = "GLOBAL" | "LOCAL";

type ContextMenuState = {
  visible: boolean;
  x: number;
  y: number;
  type: "canvas" | "node";
  nodeId?: string;
};

function App() {
  // 1) JSON からベースとなる全ノード・エッジを作る
  const { baseNodes, hierarchyEdges, dependencyEdges } = useMemo(() => {
    const rawNodes = (wbs as any).nodes || [];
    const rawEdges = (wbs as any).edges || [];

    // まず id -> Node のマップを作る（位置はあとで決める）
    const nodeMap: Record<string, WbsNode> = {};

    rawNodes.forEach((n: any) => {
      nodeMap[n.id] = {
        id: n.id,
        position: { x: 0, y: 0 },
        data: {
          label:
            n.data?.title ??
            n.data?.name ??
            `${n.type} ${n.wbs_code ?? ""}`,
          ...n.data,
        },
        type: "default",
      };
    });

    const hierarchyEdges: WbsEdge[] = [];
    const dependencyEdges: WbsEdge[] = [];

    // HIERARCHY エッジから親子関係を作る
    const childrenByParent: Record<string, string[]> = {};
    const childSet = new Set<string>();

    rawEdges.forEach((e: any) => {
      const edge: WbsEdge = {
        id: e.id,
        source: e.source,
        target: e.target,
        type: "default",
        label: e.type,
        data: {
          wbsType: e.type,
          ...(e.data || {}),
        },
      };

      if (e.type === "HIERARCHY") {
        hierarchyEdges.push(edge);

        if (!childrenByParent[e.source]) {
          childrenByParent[e.source] = [];
        }
        childrenByParent[e.source].push(e.target);
        childSet.add(e.target);
      } else {
        dependencyEdges.push(edge);
      }
    });

    // レベル（階層）を計算：子として一度も登場しないノードが root
    const allNodeIds = Object.keys(nodeMap);
    const roots = allNodeIds.filter((id) => !childSet.has(id));

    const levels: Record<string, number> = {};
    const queue: string[] = [];

    // root をレベル0として BFS
    roots.forEach((id) => {
      levels[id] = 0;
      queue.push(id);
    });

    while (queue.length > 0) {
      const parentId = queue.shift() as string;
      const level = levels[parentId];
      const children = childrenByParent[parentId] || [];

      children.forEach((childId) => {
        if (levels[childId] === undefined) {
          levels[childId] = level + 1;
          queue.push(childId);
        }
      });
    }

    // どこにもぶら下がっていないノードがあればレベル0にしておく
    allNodeIds.forEach((id) => {
      if (levels[id] === undefined) {
        levels[id] = 0;
      }
    });

    // レベルごとにノードをグループ化
    const grouped: Record<number, WbsNode[]> = {};
    allNodeIds.forEach((id) => {
      const level = levels[id];
      if (!grouped[level]) grouped[level] = [];
      grouped[level].push(nodeMap[id]);
    });

    // CUI の tree 風に：レベルごとに X、id順でYを並べる
    const baseNodes: WbsNode[] = [];
    const xGap = 260;
    const yGap = 120;

    Object.keys(grouped)
      .map((l) => Number(l))
      .sort((a, b) => a - b)
      .forEach((level) => {
        const nodesAtLevel = grouped[level];

        // id が数値なら数値ソート、そうでなければ文字列ソート
        nodesAtLevel.sort((a, b) => {
          const aNum = Number(a.id);
          const bNum = Number(b.id);
          if (!Number.isNaN(aNum) && !Number.isNaN(bNum) && aNum !== bNum) {
            return aNum - bNum;
          }
          return String(a.id).localeCompare(String(b.id));
        });

        nodesAtLevel.forEach((node, index) => {
          node.position = {
            x: level * xGap,
            y: index * yGap,
          };
          baseNodes.push(node);
        });
      });

    return { baseNodes, hierarchyEdges, dependencyEdges };
  }, []);

  // 2) 表示モードとフォーカスノード（ローカルビュー用）
  const [viewMode, setViewMode] = useState<ViewMode>("GLOBAL");
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);

  // 3) コンテキストメニューの状態
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    type: "canvas",
  });

  const hideContextMenu = () =>
    setContextMenu((prev) => ({ ...prev, visible: false }));

  // 4) viewMode / focusNodeId に応じて表示する nodes / edges を切り替え
  const { nodes, edges } = useMemo(() => {
    // グローバルビュー：WBSツリー（階層エッジのみ）
    if (viewMode === "GLOBAL" || !focusNodeId) {
      return {
        nodes: baseNodes,
        edges: hierarchyEdges,
      };
    }

    // ローカルビュー：指定ノードを中心としたスター型
    const center = baseNodes.find((n) => n.id === focusNodeId);
    if (!center) {
      return {
        nodes: baseNodes,
        edges: hierarchyEdges,
      };
    }

    // 中心ノードに接続しているエッジのみ（階層＋依存）
    const incidentEdges = [...hierarchyEdges, ...dependencyEdges].filter(
      (e) => e.source === focusNodeId || e.target === focusNodeId
    );

    const neighborIds = new Set<string>();
    incidentEdges.forEach((e) => {
      if (e.source === focusNodeId) neighborIds.add(e.target);
      if (e.target === focusNodeId) neighborIds.add(e.source);
    });

    const neighbors = baseNodes.filter((n) => neighborIds.has(n.id));

    // スター型レイアウト：中心(0,0)、周囲を円形に配置
    const cx = 0;
    const cy = 0;
    const r = 220;
    const centerNode: WbsNode = {
      ...center,
      position: { x: cx, y: cy },
    };

    const neighborNodes: WbsNode[] =
      neighbors.length === 0
        ? []
        : neighbors.map((n, index) => {
            const angle = (2 * Math.PI * index) / neighbors.length;
            const x = cx + r * Math.cos(angle);
            const y = cy + r * Math.sin(angle);
            return {
              ...n,
              position: { x, y },
            };
          });

    return {
      nodes: [centerNode, ...neighborNodes],
      edges: incidentEdges,
    };
  }, [viewMode, focusNodeId, baseNodes, hierarchyEdges, dependencyEdges]);

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        // 左クリック系：メニューを閉じつつログだけ出す
        onNodeClick={(event, node) => {
          hideContextMenu();
          console.log("Node clicked:", node);
        }}
        onEdgeClick={(event, edge) => {
          hideContextMenu();
          console.log("Edge clicked:", edge);
        }}
        onPaneClick={() => {
          hideContextMenu();
        }}
        // キャンバス右クリック
        onPaneContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({
            visible: true,
            x: event.clientX,
            y: event.clientY,
            type: "canvas",
          });
        }}
        // ノード右クリック
        onNodeContextMenu={(event, node) => {
          event.preventDefault();
          setContextMenu({
            visible: true,
            x: event.clientX,
            y: event.clientY,
            type: "node",
            nodeId: node.id,
          });
          console.log("Node right-clicked:", node);
        }}
      >
        <Background />
        <MiniMap />
        <Controls />
      </ReactFlow>

      {/* 簡易コンテキストメニュー */}
      {contextMenu.visible && (
        <div
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
            background: "#ffffff",
            border: "1px solid #ccc",
            boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
            zIndex: 1000,
            minWidth: "160px",
            fontSize: "14px",
          }}
        >
          {contextMenu.type === "canvas" && (
            <div
              style={{ padding: "4px 8px", cursor: "pointer" }}
              onClick={() => {
                setViewMode("GLOBAL");
                setFocusNodeId(null);
                hideContextMenu();
              }}
            >
              WBSに戻る
            </div>
          )}

          {contextMenu.type === "node" && (
            <>
              <div
                style={{ padding: "4px 8px", cursor: "pointer" }}
                onClick={() => {
                  if (contextMenu.nodeId) {
                    setViewMode("LOCAL");
                    setFocusNodeId(contextMenu.nodeId);
                  }
                  hideContextMenu();
                }}
              >
                接続されたノードの一覧
              </div>
              <div
                style={{ padding: "4px 8px", cursor: "pointer" }}
                onClick={() => {
                  console.log(
                    "接続するノードを新規作成（まだダミー実装） for",
                    contextMenu.nodeId
                  );
                  alert("新規ノード作成はまだダミー実装です。");
                  hideContextMenu();
                }}
              >
                接続するノードを新規作成
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
