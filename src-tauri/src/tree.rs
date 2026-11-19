//! Flatten BSON documents into the key / value / type rows the tree view renders.

use crate::shell_json::{format_date, format_double, to_shell_inline};
use bson::{spec::BinarySubtype, Bson, Document};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub key: String,
    /// BSON type name shown in the Type column (ObjectId, String, Int32, …).
    pub type_name: String,
    /// Text for the Value column. Strings are shown without quotes.
    pub value: String,
    /// Child rows for documents and arrays; `None` for scalar values.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
}

pub fn type_name(value: &Bson) -> &'static str {
    match value {
        Bson::Double(_) => "Double",
        Bson::String(_) => "String",
        Bson::Document(_) => "Object",
        Bson::Array(_) => "Array",
        Bson::Binary(b) if b.subtype == BinarySubtype::Uuid => "UUID",
        Bson::Binary(_) => "Binary",
        Bson::Undefined => "Undefined",
        Bson::ObjectId(_) => "ObjectId",
        Bson::Boolean(_) => "Boolean",
        Bson::DateTime(_) => "Date",
        Bson::Null => "Null",
        Bson::RegularExpression(_) => "Regex",
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => "JavaScript",
        Bson::Symbol(_) => "Symbol",
        Bson::Int32(_) => "Int32",
        Bson::Timestamp(_) => "Timestamp",
        Bson::Int64(_) => "Int64",
        Bson::Decimal128(_) => "Decimal128",
        Bson::MinKey => "MinKey",
        Bson::MaxKey => "MaxKey",
        Bson::DbPointer(_) => "DBPointer",
    }
}

fn display(value: &Bson) -> String {
    match value {
        Bson::String(s) => s.clone(),
        Bson::ObjectId(o) => o.to_hex(),
        Bson::DateTime(dt) => format_date(dt),
        Bson::Double(v) => format_double(*v),
        Bson::Int32(v) => v.to_string(),
        Bson::Int64(v) => v.to_string(),
        Bson::Decimal128(d) => d.to_string(),
        Bson::Document(d) => plural(d.len(), "field", "{ ", " }"),
        Bson::Array(a) => plural(a.len(), "element", "[ ", " ]"),
        other => to_shell_inline(other),
    }
}

fn plural(n: usize, word: &str, open: &str, close: &str) -> String {
    format!("{open}{n} {word}{}{close}", if n == 1 { "" } else { "s" })
}

pub fn node(key: String, value: &Bson) -> TreeNode {
    let children = match value {
        Bson::Document(d) => Some(d.iter().map(|(k, v)| node(k.clone(), v)).collect()),
        Bson::Array(items) => Some(items.iter().enumerate().map(|(i, v)| node(format!("[{i}]"), v)).collect()),
        _ => None,
    };
    TreeNode { key, type_name: type_name(value).to_string(), value: display(value), children }
}

/// Top-level row for one result document: `(1) { _id: … }`.
pub fn document_node(index: usize, doc: &Document) -> TreeNode {
    let label = match doc.get("_id") {
        Some(id) => format!("({}) {{ _id: {} }}", index + 1, display(id)),
        None => format!("({})", index + 1),
    };
    TreeNode {
        key: label,
        type_name: "Document".into(),
        value: plural(doc.len(), "field", "{ ", " }"),
        children: Some(doc.iter().map(|(k, v)| node(k.clone(), v)).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;

    #[test]
    fn builds_rows() {
        let d = doc! { "_id": 1i32, "name": "x", "driver": { "id": "d1" }, "stops": [1i32, 2i32] };
        let n = document_node(0, &d);
        assert_eq!(n.key, "(1) { _id: 1 }");
        assert_eq!(n.value, "{ 4 fields }");
        let kids = n.children.unwrap();
        assert_eq!(kids[1].value, "x");
        assert_eq!(kids[1].type_name, "String");
        assert_eq!(kids[2].value, "{ 1 field }");
        assert_eq!(kids[3].children.as_ref().unwrap()[1].key, "[1]");
        assert_eq!(kids[3].value, "[ 2 elements ]");
    }
}
