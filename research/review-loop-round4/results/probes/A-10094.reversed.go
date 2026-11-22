package main
import("encoding/json";"os")
func reachedResizeErrorBranch()string{

				// Error during resize, will retry if recommendation changes.
				return "InPlaceInfeasible"
			
}
func main(){json.NewEncoder(os.Stdout).Encode(map[string]bool{"transientErrorDeferred":reachedResizeErrorBranch()=="InPlaceDeferred"})}
