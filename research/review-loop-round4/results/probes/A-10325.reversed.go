package main
import("time";"encoding/json";"os")
type Stamp struct{time.Time}
type Terminated struct{Reason string;StartedAt,FinishedAt Stamp}
func quick(start,finish,now time.Time)bool{
 terminationState:=struct{Terminated *Terminated}{&Terminated{"OOMKilled",Stamp{start},Stamp{finish}}}
 evictOOMThreshold:=10*time.Minute
 _=now
 return terminationState.Terminated != nil &&
			terminationState.Terminated.Reason == "OOMKilled" &&
			terminationState.Terminated.FinishedAt.Sub(terminationState.Terminated.StartedAt.Time) < evictOOMThreshold
}
func main(){now:=time.Unix(1000000,0);old:=now.Add(-240*time.Hour);recent:=now.Add(-time.Minute);json.NewEncoder(os.Stdout).Encode(map[string]bool{"staleQuickIgnored":!quick(old.Add(-2*time.Minute),old,now),"recentQuickRecognized":quick(recent.Add(-2*time.Minute),recent,now),"longRuntimeIgnored":!quick(recent.Add(-time.Hour),recent,now)})}
