package main
import("encoding/json";"os")
type Node struct{Labels map[string]string}
func extractNodeLabels(node *Node) map[string]string {
	m := make(map[string]string)
	if node.Labels == nil {
		return m
	}

	setLabelIfNotEmpty(m, node.Labels, "LabelArchStable")

	setLabelIfNotEmpty(m, node.Labels, "LabelOSStable")

	setLabelIfNotEmpty(m, node.Labels, "LabelInstanceType")
	setLabelIfNotEmpty(m, node.Labels, "LabelInstanceTypeStable")

	setLabelIfNotEmpty(m, node.Labels, "LabelZoneRegion")
	setLabelIfNotEmpty(m, node.Labels, "LabelZoneRegionStable")

	setLabelIfNotEmpty(m, node.Labels, "LabelZoneFailureDomain")
	setLabelIfNotEmpty(m, node.Labels, "LabelTopologyZone")

	return m
}
func setLabelIfNotEmpty(to, from map[string]string, key string) {
	if value := from[key]; value != "" {
		to[key] = value
	}
}
func main(){labels:=extractNodeLabels(&Node{map[string]string{"LabelTopologyZone":"zone-a","LabelZoneFailureDomain":"legacy-a"}});json.NewEncoder(os.Stdout).Encode(map[string]bool{"stableZonePreserved":labels["LabelTopologyZone"]=="zone-a","legacyZonePreserved":labels["LabelZoneFailureDomain"]=="legacy-a","nilLabelsAccepted":len(extractNodeLabels(&Node{}))==0})}
