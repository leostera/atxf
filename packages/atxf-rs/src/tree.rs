//! The tree of records and the active leaf (SPEC §4).

use std::collections::{HashMap, HashSet};

use crate::json::Map;
use crate::transcript::{Record, Transcript};

/// Lookup structures over a transcript's tree.
#[derive(Clone, Debug, Default)]
pub struct TreeIndex<'a> {
    /// Tree records by id.
    pub nodes: HashMap<&'a str, &'a Map>,
    /// Child ids by parent id, in file order. Roots are under `None`.
    pub children: HashMap<Option<&'a str>, Vec<&'a str>>,
    /// Tree record ids in file order.
    pub order: Vec<&'a str>,
    /// The active leaf, or `None` for an empty active path.
    pub active_leaf: Option<&'a str>,
}

pub fn index_tree(transcript: &Transcript) -> TreeIndex<'_> {
    let mut index = TreeIndex::default();
    for record in &transcript.records {
        if record.is_tree() {
            let id = record.id();
            if index.nodes.insert(id, record).is_none() {
                index.order.push(id);
            }
            index.children.entry(record.parent_id()).or_default().push(id);
            index.active_leaf = Some(id);
        } else if record.kind() == "leaf" {
            index.active_leaf = crate::json::Get::str(record, "targetId");
        }
    }
    index
}

/// The records from the root to `leaf`, root first.
pub fn path_to<'a>(index: &TreeIndex<'a>, leaf: Option<&str>) -> Vec<&'a Map> {
    let mut path = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = leaf;
    while let Some(id) = cursor {
        let Some(node) = index.nodes.get(id) else { break };
        if !seen.insert(id.to_string()) {
            break;
        }
        path.push(*node);
        cursor = node.parent_id();
    }
    path.reverse();
    path
}

pub fn active_path<'a>(index: &TreeIndex<'a>) -> Vec<&'a Map> {
    path_to(index, index.active_leaf)
}

/// Every leaf of the tree (records with no children), in file order.
pub fn leaves<'a>(index: &TreeIndex<'a>) -> Vec<&'a str> {
    index.order.iter().copied().filter(|id| !index.children.contains_key(&Some(*id))).collect()
}
