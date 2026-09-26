module Gtd.Data exposing
    ( Action
    , File
    , InboxItem
    , Issue
    , Project
    , Schedule(..)
    , Snapshot
    , actionDecoder
    , areas
    , contexts
    , empty
    , findAction
    , findProject
    , projectArea
    , projectDecoder
    , schedule
    , scheduleText
    , snapshotDecoder
    )

{-| The snapshot the host serialises for every Elm surface.

One record per entity, decoded once here, so that a field means the same thing on
the board, in the Inbox, and inside a modal.

-}

import Gtd.ActionStatus as ActionStatus exposing (ActionStatus)
import Gtd.Energy as Energy exposing (Energy)
import Gtd.Id exposing (ActionId, InboxItemId, ProjectId)
import Gtd.ProjectStatus as ProjectStatus exposing (ProjectStatus)
import Gtd.Settings as Settings exposing (Settings)
import Json.Decode as Decode exposing (Decoder)
import Set


type alias File =
    { path : String
    , name : String
    , basename : String
    , extension : String
    }


type alias Action =
    { id : ActionId
    , title : String
    , file : File
    , status : ActionStatus
    , created : String
    , projectId : Maybe ProjectId
    , context : Maybe String
    , energy : Maybe Energy
    , due : Maybe String
    , waitingSince : Maybe String
    , followUp : Maybe String
    , scheduledStart : Maybe String
    , scheduledLocal : Maybe String
    , durationMinutes : Maybe Int
    , priority : Maybe Int
    }


type alias Project =
    { id : ProjectId
    , title : String
    , file : File
    , status : ProjectStatus
    , area : Maybe String
    , reviewed : Maybe String
    , activateAt : Maybe String
    , supportPath : Maybe String
    , image : Maybe String
    , tags : List String
    , order : Maybe Int
    , blockedByProjectIds : List ProjectId
    , parentProjectId : Maybe ProjectId
    }


type alias InboxItem =
    { id : InboxItemId
    , title : String
    , created : String
    , file : File
    , resourceUrl : String
    , legacyAction : Bool
    , messageId : Maybe String
    }


type alias Issue =
    { path : String, message : String }


type alias Snapshot =
    { revision : Int
    , today : String
    , inboxItems : List InboxItem
    , actions : List Action
    , projects : List Project
    , issues : List Issue
    , settings : Settings
    }


{-| What a Scheduled Action reserves on the calendar.

`scheduled_start` written as a plain date means the Action owns the whole day and
therefore has no duration; anything else is an instant that needs one.

-}
type Schedule
    = AllDay String
    | Timed String Int


empty : Snapshot
empty =
    { revision = 0
    , today = ""
    , inboxItems = []
    , actions = []
    , projects = []
    , issues = []
    , settings = Settings.empty
    }



-- QUERIES


findAction : ActionId -> List Action -> Maybe Action
findAction actionId actions =
    List.filter (\action -> action.id == actionId) actions |> List.head


findProject : ProjectId -> List Project -> Maybe Project
findProject projectId projects =
    List.filter (\project -> project.id == projectId) projects |> List.head


{-| Every context in use, sorted, for pickers and filters.
-}
contexts : List Action -> List String
contexts actions =
    actions |> List.filterMap .context |> Set.fromList |> Set.toList |> List.sort


{-| A Project's area, trimmed, or nothing when it is blank.
-}
projectArea : Project -> Maybe String
projectArea project =
    project.area
        |> Maybe.map String.trim
        |> Maybe.andThen
            (\area ->
                if String.isEmpty area then
                    Nothing

                else
                    Just area
            )


{-| The distinct areas these Projects use, alphabetically, ignoring case.
-}
areas : List Project -> List String
areas projects =
    projects |> List.filterMap projectArea |> Set.fromList |> Set.toList |> List.sortBy String.toLower


{-| The complete schedule an Action carries, or `Nothing` while it is still missing a piece.
-}
schedule : Action -> Maybe Schedule
schedule action =
    case action.scheduledStart of
        Nothing ->
            Nothing

        Just start ->
            if isDateOnly start then
                Just (AllDay start)

            else
                Maybe.map (Timed start) action.durationMinutes


{-| How a card or row words an Action's schedule, in local time: "Today 09:00–10:30",
"2026-10-02 14:00–14:45" or "2026-10-02 · all day".
-}
scheduleText : String -> Action -> Maybe String
scheduleText today action =
    let
        day date =
            if date == today then
                "Today"

            else
                date
    in
    case ( schedule action, action.status ) of
        ( Just (AllDay date), _ ) ->
            Just (day date ++ " · all day")

        ( Just (Timed start minutes), _ ) ->
            let
                -- The host sends the local wall-clock time; the stored start is UTC.
                local =
                    Maybe.withDefault start action.scheduledLocal

                time =
                    String.slice 11 16 local
            in
            Just (day (String.left 10 local) ++ " " ++ time ++ "–" ++ addMinutes time minutes)

        ( Nothing, ActionStatus.Scheduled ) ->
            Just "Missing schedule"

        ( Nothing, _ ) ->
            Nothing


{-| An `HH:mm` clock time moved on by some minutes, wrapping past midnight.
-}
addMinutes : String -> Int -> String
addMinutes time minutes =
    case List.map String.toInt (String.split ":" time) of
        [ Just hours, Just mins ] ->
            let
                total =
                    modBy (24 * 60) (hours * 60 + mins + minutes)

                pad n =
                    String.padLeft 2 '0' (String.fromInt n)
            in
            pad (total // 60) ++ ":" ++ pad (modBy 60 total)

        _ ->
            "+" ++ String.fromInt minutes ++ " min"


isDateOnly : String -> Bool
isDateOnly value =
    String.length value == 10 && String.contains "-" value



-- DECODING


snapshotDecoder : Decoder Snapshot
snapshotDecoder =
    Decode.succeed Snapshot
        |> required "revision" Decode.int
        |> optional "today" Decode.string ""
        |> optional "inboxItems" (Decode.list inboxItemDecoder) []
        |> required "actions" (Decode.list actionDecoder)
        |> required "projects" (Decode.list projectDecoder)
        |> optional "issues" (Decode.list issueDecoder) []
        |> required "settings" Settings.decoder


fileDecoder : Decoder File
fileDecoder =
    Decode.map4 File
        (Decode.field "path" Decode.string)
        (optionalField "name" Decode.string "")
        (optionalField "basename" Decode.string "")
        (optionalField "extension" Decode.string "")


actionDecoder : Decoder Action
actionDecoder =
    Decode.succeed Action
        |> required "id" Decode.string
        |> required "title" Decode.string
        |> required "file" fileDecoder
        |> required "status" ActionStatus.decoder
        |> optional "created" Decode.string ""
        |> optional "projectId" (Decode.maybe Decode.string) Nothing
        |> optional "context" (Decode.maybe Decode.string) Nothing
        |> optional "energy" (Decode.maybe Energy.decoder) Nothing
        |> optional "due" (Decode.maybe Decode.string) Nothing
        |> optional "waitingSince" (Decode.maybe Decode.string) Nothing
        |> optional "followUp" (Decode.maybe Decode.string) Nothing
        |> optional "scheduledStart" (Decode.maybe Decode.string) Nothing
        |> optional "scheduledLocal" (Decode.maybe Decode.string) Nothing
        |> optional "durationMinutes" (Decode.maybe Decode.int) Nothing
        |> optional "priority" (Decode.maybe Decode.int) Nothing


projectDecoder : Decoder Project
projectDecoder =
    Decode.succeed Project
        |> required "id" Decode.string
        |> required "title" Decode.string
        |> required "file" fileDecoder
        |> required "status" ProjectStatus.decoder
        |> optional "area" (Decode.maybe Decode.string) Nothing
        |> optional "reviewed" (Decode.maybe Decode.string) Nothing
        |> optional "activateAt" (Decode.maybe Decode.string) Nothing
        |> optional "supportPath" (Decode.maybe Decode.string) Nothing
        |> optional "image" (Decode.maybe Decode.string) Nothing
        |> optional "tags" (Decode.list Decode.string) []
        |> optional "order" (Decode.maybe Decode.int) Nothing
        |> optional "blockedByProjectIds" (Decode.list Decode.string) []
        |> optional "parentProjectId" (Decode.maybe Decode.string) Nothing


inboxItemDecoder : Decoder InboxItem
inboxItemDecoder =
    Decode.map7 InboxItem
        (Decode.field "id" Decode.string)
        (Decode.field "title" Decode.string)
        (Decode.field "created" Decode.string)
        (Decode.field "file" fileDecoder)
        (optionalField "resourceUrl" Decode.string "")
        (optionalField "legacyAction" Decode.bool False)
        (optionalField "messageId" (Decode.map Just Decode.string) Nothing)


issueDecoder : Decoder Issue
issueDecoder =
    Decode.map2 Issue (Decode.field "path" Decode.string) (Decode.field "message" Decode.string)


required : String -> Decoder a -> Decoder (a -> b) -> Decoder b
required name decoder pipeline =
    Decode.map2 (<|) pipeline (Decode.field name decoder)


optional : String -> Decoder a -> a -> Decoder (a -> b) -> Decoder b
optional name decoder fallback pipeline =
    Decode.map2 (<|) pipeline (optionalField name decoder fallback)


optionalField : String -> Decoder a -> a -> Decoder a
optionalField name decoder fallback =
    Decode.oneOf [ Decode.field name decoder, Decode.succeed fallback ]
